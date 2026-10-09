import {
  user,
  grant,
  request,
  setup,
  joined,
  publication,
  publishReady,
} from "@tests/helpers/media-room";
import { barrier } from "@tests/helpers/barrier";
import { forwardingCount } from "@tests/helpers/media-lifecycle";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
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

describe("media negotiation ownership on native actors", () => {
  it("holds producer ownership until answer-application ACK and preserves the phase through eviction", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const command = publication(accepted.handle, [
      "microphone",
      "camera",
      "screen_video",
      "screen_audio",
    ]);
    const published = MediaOutcomeSchema.parse(
      await s.media.publish(s.principal, grant(s.principal, s.scope), command),
    );
    if (published.kind !== "negotiation")
      throw new Error("Expected negotiation");
    expect(published.phase).toBe("awaiting_apply");
    expect(
      await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
      }),
    ).toMatchObject({
      kind: "media_snapshot",
      snapshot: { participants: [{ publications: [] }] },
    });
    expect(
      await s.media.publish(s.principal, grant(s.principal, s.scope), {
        ...command,
        operationId: crypto.randomUUID(),
        expectedSessionVersion: 1,
        tracks: [{ source: "camera", mid: "1" }],
      }),
    ).toMatchObject({ kind: "session_busy" });
    await evictDurableObject(s.media);
    expect(
      await s.media.publish(s.principal, grant(s.principal, s.scope), command),
    ).toEqual(published);
    const ack = {
      handle: accepted.handle,
      operationId: published.operationId,
      expectedSessionVersion: 1,
    };
    expect(
      await s.media.ack(s.principal, grant(s.principal, s.scope), ack),
    ).toMatchObject({ kind: "completed" });
    expect(
      await s.media.ack(s.principal, grant(s.principal, s.scope), ack),
    ).toMatchObject({ kind: "completed" });
    expect(
      await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
      }),
    ).toMatchObject({
      kind: "media_snapshot",
      snapshot: { participants: [{ publications: expect.any(Array) }] },
    });
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM media_publications WHERE ready=1",
          )
          .one(),
      ).toEqual({ count: 4 });
    });
  });
  it("rejects audio disguised as camera before allocating any provider track", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const command = publication(accepted.handle);
    expect(
      await s.media.publish(
        s.principal,
        { ...grant(s.principal, s.scope), canSpeak: false },
        { ...command, tracks: [{ source: "camera", mid: "0" }] },
      ),
    ).toEqual({ kind: "invalid_input" });
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/tracks/new")),
    ).toHaveLength(0);
  });
  it("keeps consumer ownership across browser answer and backend renegotiation, with duplicate completion safe", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const published = await publishReady(s, accepted.handle);
    const other = user();
    const otherAccount = env.ACCOUNT_MEDIA.getByName(other.userId);
    const receiver = joined(
      await otherAccount.join(other, grant(other, s.scope), request(s.scope)),
    );
    const command = {
      handle: receiver.handle,
      operationId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedSessionVersion: 0,
      publicationIds: published.publications.map((pub) => pub.id),
    };
    const subscribed = MediaOutcomeSchema.parse(
      await s.media.subscribe(other, grant(other, s.scope), command),
    );
    if (subscribed.kind !== "negotiation") throw new Error("Expected offer");
    expect(subscribed.phase).toBe("awaiting_answer");
    expect(
      await s.media.subscribe(other, grant(other, s.scope), {
        ...command,
        operationId: crypto.randomUUID(),
        expectedSessionVersion: 1,
      }),
    ).toMatchObject({ kind: "session_busy" });
    await evictDurableObject(s.media);
    expect(
      await s.media.subscribe(other, grant(other, s.scope), command),
    ).toEqual(subscribed);
    const answer = {
      handle: receiver.handle,
      operationId: subscribed.operationId,
      expectedSessionVersion: 1,
      sessionDescription: { type: "answer" as const, sdp: "v=0\r\n" },
    };
    expect(
      await s.media.answer(other, grant(other, s.scope), answer),
    ).toMatchObject({
      kind: "completed",
      subscriptions: subscribed.subscriptions,
    });
    expect(
      await s.media.answer(other, grant(other, s.scope), answer),
    ).toMatchObject({
      kind: "completed",
      subscriptions: subscribed.subscriptions,
    });
    expect(
      await s.media.answer(other, grant(other, s.scope), {
        ...answer,
        sessionDescription: { type: "answer", sdp: "changed" },
      }),
    ).toEqual({ kind: "command_conflict" });
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/renegotiate")),
    ).toHaveLength(1);
  });
  it("preserves and forcibly closes partial allocations without advertising the successful subset prematurely", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    s.fake.partialPublish = true;
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle, ["microphone", "camera"]),
      ),
    ).toMatchObject({ kind: "provider_error" });
    expect(
      [...s.fake.sessions.values()].every(
        (session) => session.tracks.size === 0,
      ),
    ).toBe(true);
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM media_allocations").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM media_publications WHERE ready=1",
          )
          .one(),
      ).toEqual({ count: 0 });
    });
  });
  it.each([false, true])(
    "rejects and cleans up a delayed publication after Leave (hold response until Leave returns: %s)",
    async (holdUntilLeave) => {
      const s = setup();
      const accepted = joined(
        await s.account.join(
          s.principal,
          grant(s.principal, s.scope),
          request(s.scope),
        ),
      );
      const gate = barrier();
      s.fake.publishGate = gate.promise;
      const publishing = s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle),
      );
      let leaving;
      let responseReleased = false;
      try {
        await expect
          .poll(() =>
            s.fake.calls.some((call) => call.path.endsWith("/tracks/new")),
          )
          .toBe(true);
        expect(forwardingCount(s.fake)).toBe(1);
        leaving = s.account
          .leave(s.principal, {
            handle: accepted.handle,
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          })
          .then((outcome) => ({
            outcome,
            responseReleased,
            // Capture cleanup at Leave's response, before publication can mask it.
            forwarding: forwardingCount(s.fake),
          }));
        await expect
          .poll(() =>
            runInDurableObject(
              s.media,
              (_instance, state) =>
                state.storage.sql
                  .exec<{ status: string }>(
                    "SELECT status FROM media_participants WHERE id=? AND generation=?",
                    accepted.handle.participantId,
                    accepted.generation,
                  )
                  .one().status,
            ),
          )
          .toBe("closing");
        if (holdUntilLeave)
          expect((await leaving).outcome).toMatchObject({
            kind: "left",
            cleanupPending: true,
          });
      } finally {
        responseReleased = true;
        gate.release();
        await Promise.allSettled([publishing, leaving]);
      }
      const left = await leaving;
      expect(left.outcome).toMatchObject({ kind: "left" });
      if (left.outcome.kind === "left" && !left.outcome.cleanupPending)
        expect(left).toMatchObject({ responseReleased: true, forwarding: 0 });
      expect(await publishing).toMatchObject({ kind: "stale_generation" });
      await expect.poll(() => forwardingCount(s.fake)).toBe(0);
      await expect
        .poll(() => s.account.status(s.principal))
        .toMatchObject({
          generation: accepted.generation + 1,
          admission: { kind: "available" },
        });
    },
  );
  it("expires missing browser answers and permissions through durable alarm cleanup", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      publication(accepted.handle),
    );
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_sessions SET deadline=1 WHERE operation_id IS NOT NULL",
      );
    });
    await evictDurableObject(s.media);
    expect(await runDurableObjectAlarm(s.media)).toBe(true);
    expect(
      [...s.fake.sessions.values()].every(
        (session) => session.tracks.size === 0,
      ),
    ).toBe(true);
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle),
      ),
    ).toEqual({
      kind: "recovery_required",
      handle: accepted.handle,
      reason: "negotiation_expired",
    });
  });
  it("closes screen audio along with screen video while preserving microphone and camera", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle, [
      "microphone",
      "camera",
      "screen_video",
      "screen_audio",
    ]);
    expect(
      await s.media.unpublish(s.principal, grant(s.principal, s.scope), {
        handle: accepted.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 1,
        sources: ["screen_video"],
      }),
    ).toMatchObject({ kind: "completed" });
    const snapshot = MediaOutcomeSchema.parse(
      await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
      }),
    );
    if (snapshot.kind !== "media_snapshot")
      throw new Error("Expected snapshot");
    expect(
      snapshot.snapshot.participants[0]?.publications
        .map((pub) => pub.source)
        .sort(),
    ).toEqual(["camera", "microphone"]);
  });
  it("rejects missing publication targets atomically without reserving a receiving operation", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    expect(
      await s.media.subscribe(s.principal, grant(s.principal, s.scope), {
        handle: accepted.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        publicationIds: [crypto.randomUUID()],
      }),
    ).toEqual({ kind: "publication_unavailable" });
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT version,phase FROM media_sessions WHERE direction='consumer'",
          )
          .one(),
      ).toEqual({ version: 0, phase: "idle" });
      expect(
        state.storage.sql.exec("SELECT * FROM media_operations").toArray(),
      ).toEqual([]);
    });
  });
});
