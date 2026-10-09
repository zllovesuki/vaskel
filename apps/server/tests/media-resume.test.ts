import {
  room,
  grant,
  token,
  request,
  setup,
  joined,
  publication,
  publishReady,
} from "@tests/helpers/media-room";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mediaNetwork } from "@tests/helpers/media-network";

beforeAll(async () => {
  await mediaNetwork.enable();
});
afterEach(() => {
  mediaNetwork.resetHandlers();
});
afterAll(async () => {
  // Terminate isolated actors before removing their provider interception.
  await abortAllDurableObjects();
  await mediaNetwork.disable();
});

describe("media resume capabilities and recovery on native actors", () => {
  it("advances generation on refresh CAS and fences cloned or stale handles after explicit leave", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const resume = {
      nextDeviceToken: token(),
      handle: accepted.handle,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    };
    const results = await Promise.all([
      s.account.resume(s.principal, grant(s.principal, s.scope), resume),
      s.account.resume(s.principal, grant(s.principal, s.scope), {
        ...resume,
        commandId: crypto.randomUUID(),
      }),
    ]);
    const refreshed = results.find((result) => result.kind === "joined");
    expect(refreshed?.kind).toBe("joined");
    expect(results.some((result) => result.kind === "stale_generation")).toBe(
      true,
    );
    if (refreshed?.kind !== "joined") throw new Error("Expected refreshed");
    expect(refreshed.handle.participantId).toBe(accepted.handle.participantId);
    expect(refreshed.handle.accountGeneration).toBe(2);
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle),
      ),
    ).toMatchObject({ kind: "stale_generation" });
    expect(
      await s.account.leave(s.principal, {
        handle: refreshed.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "left", cleanupPending: false });
    expect(
      await s.account.resume(s.principal, grant(s.principal, s.scope), {
        nextDeviceToken: token(),
        handle: refreshed.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "stale_generation" });
    expect(await s.account.status(s.principal)).toMatchObject({
      admission: { kind: "available" },
    });
  });
  it("expires authorization forwarding leases and allows a fresh current-device resume without restoring camera", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle, ["microphone", "camera"]);
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec("UPDATE media_participants SET lease_expires=1");
    });
    await evictDurableObject(s.media);
    expect(await runDurableObjectAlarm(s.media)).toBe(true);
    expect(
      [...s.fake.sessions.values()].every(
        (session) => session.tracks.size === 0,
      ),
    ).toBe(true);
    const refreshed = joined(
      await s.account.resume(s.principal, grant(s.principal, s.scope), {
        nextDeviceToken: token(),
        handle: accepted.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    );
    expect(refreshed.generation).toBe(2);
    expect(refreshed.snapshot.participants[0]?.publications).toEqual([]);
  });
  it("rejects edited resume rooms and participant identities before mutation", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const target = room();
    expect(
      await s.account.resume(s.principal, grant(s.principal, target), {
        handle: { ...accepted.handle, room: target },
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await s.account.resume(s.principal, grant(s.principal, s.scope), {
        handle: { ...accepted.handle, participantId: crypto.randomUUID() },
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toEqual({ kind: "forbidden" });
    expect(await s.account.status(s.principal)).toMatchObject({
      generation: 1,
      admission: { kind: "transfer_required", room: s.scope },
    });
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/sessions/new")),
    ).toHaveLength(0);
  });
  it("rotates resume capabilities so a stale endpoint cannot adopt the visible head generation", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const nextDeviceToken = token();
    const command = {
      handle: accepted.handle,
      nextDeviceToken,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    };
    const refreshed = joined(
      await s.account.resume(s.principal, grant(s.principal, s.scope), command),
    );
    expect(refreshed.handle.deviceToken).toBe(nextDeviceToken);
    expect(
      await s.account.resume(s.principal, grant(s.principal, s.scope), command),
    ).toEqual(refreshed);
    expect(
      await s.account.resume(s.principal, grant(s.principal, s.scope), {
        handle: { ...accepted.handle, accountGeneration: refreshed.generation },
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toEqual({ kind: "forbidden" });
    const status = await s.account.status(s.principal);
    expect(JSON.stringify(status)).not.toContain(nextDeviceToken);
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/sessions/new")),
    ).toHaveLength(0);
  });
  it("retains a fixed wakeup after abandoned Resume cleanup and reaches explicit resume-required recovery", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle);
    const target = s.scope;
    const transfer = {
      handle: accepted.handle,
      nextDeviceToken: token(),
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    };
    s.fake.failClose = true;
    expect(
      await s.account.resume(s.principal, grant(s.principal, target), transfer),
    ).toMatchObject({ kind: "cleanup_pending", generation: 2 });
    const deadline = await runInDurableObject(
      s.account,
      (_instance, state) =>
        state.storage.sql
          .exec<{ deadline: number }>(
            "SELECT json_extract(participation, '$.deadline') AS deadline FROM account_media",
          )
          .one().deadline,
    );
    s.fake.failClose = false;
    expect(await runDurableObjectAlarm(s.account)).toBe(true);
    await runInDurableObject(s.account, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT json_extract(participation, '$.deadline') AS deadline, json_extract(participation, '$.kind') AS kind FROM account_media",
          )
          .one(),
      ).toEqual({ deadline, kind: "joining" });
      expect(await state.storage.getAlarm()).toBe(deadline);
      state.storage.sql.exec(
        "UPDATE account_media SET participation=json_set(participation, '$.deadline', 1)",
      );
    });
    expect(await runDurableObjectAlarm(s.account)).toBe(true);
    // The immediate durable cleanup wake may already have fired naturally.
    await runDurableObjectAlarm(s.account);
    await expect
      .poll(
        async () => {
          const status = await s.account.status(s.principal);
          return status.kind === "media_status"
            ? status.admission.kind
            : status.kind;
        },
        { timeout: 5000, interval: 10 },
      )
      .toBe("resumable");
    expect(await s.account.status(s.principal)).toMatchObject({
      generation: 2,
      admission: { kind: "resumable", room: target },
    });
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/sessions/new")),
    ).toHaveLength(1);
    const recovery = await s.account.resume(
      s.principal,
      grant(s.principal, target),
      transfer,
    );
    expect(recovery).toMatchObject({
      kind: "recovery_required",
      reason: "admission_failed",
    });
    if (recovery.kind !== "recovery_required")
      throw new Error("Expected accepted handle recovery.");
    const { handle } = recovery;
    expect(handle).toEqual({
      room: target,
      participantId: s.principal.userId,
      clientId: accepted.handle.clientId,
      deviceToken: transfer.nextDeviceToken,
      accountGeneration: 2,
    });
    expect(
      await s.account.resume(s.principal, grant(s.principal, target), {
        handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "joined", generation: 3 });
  });
});
