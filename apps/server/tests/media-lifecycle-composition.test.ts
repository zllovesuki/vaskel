import { barrier } from "@tests/helpers/barrier";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import { markParticipantClosing } from "@/server/actors/media/cleanup";
import {
  openMediaDatabase,
  type RoomRuntime,
} from "@/server/actors/media/store";
import { RealtimeClient } from "@/server/providers/realtime";
import {
  blockProviderSession,
  forwardingCount,
  interruptActors,
  interruptRemovalNotification,
  participant,
  providerSession,
  publishParticipant,
  removalRequest,
  restoreRemovalNotification,
  snapshot,
} from "@tests/helpers/media-lifecycle";
import { mediaNetwork, mediaNetworkProbe } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  publication,
  request,
  setup,
  token,
  user,
} from "@tests/helpers/media-room";

beforeAll(() => {
  // Boolean assertions prevent an unexpected local secret from appearing in output.
  expect(env.REALTIME_APP_ID === "fixture-app").toBe(true);
  expect(env.REALTIME_APP_SECRET === "fixture-secret").toBe(true);
  mediaNetwork.enable();
});
afterEach(() => {
  mediaNetwork.resetHandlers();
  expect(mediaNetworkProbe.blocked).toBe(0);
  expect(mediaNetworkProbe.failures).toBe(0);
  expect(mediaNetworkProbe.interceptorFailures).toBe(0);
});
afterAll(() => mediaNetwork.disable());

function withRoomState<T>(
  fixture: ReturnType<typeof setup>,
  use: (rt: RoomRuntime) => Promise<T>,
) {
  return runInDurableObject(fixture.media, (_instance, ctx) =>
    use({
      ctx,
      env,
      db: openMediaDatabase(ctx.storage),
      provider: new RealtimeClient(env),
      inflight: new Map(),
    }),
  );
}

describe("media lifecycle composition through real actors", () => {
  it("rejects a stale lease-expiry candidate after a real heartbeat renews it", async () => {
    const fixture = setup();
    const person = await participant(fixture, "fixture-lease-renewed");
    await publishParticipant(fixture, person);
    const now = Date.now();
    const selected = await withRoomState(fixture, async (rt) => {
      await rt.ctx.storage.setAlarm(now + 60_000);
      await rt.db
        .updateTable("media_participants")
        .set({ lease_expires: now - 1 })
        .execute();
      return rt.db
        .selectFrom("media_participants")
        .selectAll()
        .executeTakeFirstOrThrow();
    });
    expect(
      await fixture.media.heartbeat(
        person.principal,
        grant(person.principal, fixture.scope),
        { handle: person.accepted.handle },
      ),
    ).toMatchObject({ kind: "heartbeat" });
    // Renewal must precede the native closure decision. Once an alarm commits
    // closure, later provider I/O does not create another renewal window.
    await withRoomState(fixture, async (rt) => {
      expect(
        await rt.ctx.storage.transaction(() =>
          markParticipantClosing(rt, selected, "lease_expired", {
            kind: "lease",
            now,
          }),
        ),
      ).toBeNull();
    });
    expect((await snapshot(fixture)).participants).toMatchObject([
      {
        id: person.accepted.handle.participantId,
        generation: person.accepted.generation,
        status: "active",
        publications: [{ source: "microphone" }],
      },
    ]);
    expect(forwardingCount(fixture.fake)).toBe(1);
  });

  it.each([false, true])(
    "rechecks selected negotiation identity after completion (replacement=%s)",
    async (replace) => {
      const fixture = setup();
      const person = await participant(fixture, "fixture-negotiation-renewed");
      const selected = await fixture.media.publish(
        person.principal,
        grant(person.principal, fixture.scope),
        publication(person.accepted.handle),
      );
      if (selected.kind !== "negotiation")
        throw new Error("Expected pending publication negotiation.");
      const now = Date.now();
      const candidate = await withRoomState(fixture, async (rt) => {
        await rt.ctx.storage.setAlarm(now + 60_000);
        // Carry an obsolete expiry snapshot through real ACK. The live exchange
        // retains its valid deadline; actually expired ACK remains rejected.
        const session = await rt.db
          .selectFrom("media_sessions")
          .selectAll()
          .where("participant_id", "=", person.accepted.handle.participantId)
          .where("direction", "=", "producer")
          .executeTakeFirstOrThrow();
        const participant = await rt.db
          .selectFrom("media_participants")
          .selectAll()
          .where("id", "=", person.accepted.handle.participantId)
          .executeTakeFirstOrThrow();
        return { participant, session: { ...session, deadline: now - 1 } };
      });
      expect(
        await fixture.media.ack(
          person.principal,
          grant(person.principal, fixture.scope),
          {
            handle: person.accepted.handle,
            operationId: selected.operationId,
            expectedSessionVersion: selected.sessionVersion,
          },
        ),
      ).toMatchObject({ kind: "completed" });
      let replacement;
      if (replace) {
        const command = publication(
          person.accepted.handle,
          ["camera"],
          selected.sessionVersion,
        );
        command.tracks[0]!.mid = "1";
        command.sessionDescription.sdp = command.sessionDescription.sdp.replace(
          "a=mid:0",
          "a=mid:1",
        );
        replacement = await fixture.media.publish(
          person.principal,
          grant(person.principal, fixture.scope),
          command,
        );
        expect(replacement).toMatchObject({ kind: "negotiation" });
      }
      await withRoomState(fixture, async (rt) => {
        expect(
          await rt.ctx.storage.transaction(() =>
            markParticipantClosing(
              rt,
              candidate.participant,
              "negotiation_expired",
              {
                kind: "negotiation",
                now,
                session: candidate.session,
              },
            ),
          ),
        ).toBeNull();
      });
      if (replacement?.kind === "negotiation") {
        expect(
          await fixture.media.ack(
            person.principal,
            grant(person.principal, fixture.scope),
            {
              handle: person.accepted.handle,
              operationId: replacement.operationId,
              expectedSessionVersion: replacement.sessionVersion,
            },
          ),
        ).toMatchObject({ kind: "completed" });
      }
      expect((await snapshot(fixture)).participants).toMatchObject([
        { id: person.accepted.handle.participantId, status: "active" },
      ]);
      expect(forwardingCount(fixture.fake)).toBe(replace ? 2 : 1);
      expect(
        await fixture.media.heartbeat(
          person.principal,
          grant(person.principal, fixture.scope),
          { handle: person.accepted.handle },
        ),
      ).toMatchObject({ kind: "heartbeat" });
    },
  );

  it.each([
    "cleanup-before-resume",
    "resume-before-cleanup",
    "notification-before-resume",
  ] as const)(
    "prevents inherited readmission after interrupted removal: %s",
    async (order) => {
      const fixture = setup();
      const person = await participant(fixture, "fixture-removed");
      await publishParticipant(fixture, person);
      if (order === "resume-before-cleanup") fixture.fake.failClose = true;
      await interruptRemovalNotification(fixture, person);
      // Interrupt the actors with the notification failure still installed.
      // This official helper preserves their real SQL and scheduled alarms.
      await interruptActors(fixture, person);
      if (order === "cleanup-before-resume") {
        await runDurableObjectAlarm(fixture.media);
        expect(forwardingCount(fixture.fake)).toBe(0);
        expect((await snapshot(fixture)).participants).toEqual([]);
      }
      if (order === "notification-before-resume") {
        await restoreRemovalNotification(person);
        await runInDurableObject(fixture.media, (_instance, ctx) => {
          // Explicit native alarm invocation does not advance its retry clock.
          ctx.storage.sql.exec(
            "UPDATE media_participants SET cleanup_at=? WHERE cleanup_at IS NOT NULL",
            Date.now(),
          );
        });
        await runDurableObjectAlarm(fixture.media);
        await runDurableObjectAlarm(person.account);
        expect(await person.account.status(person.principal)).toMatchObject({
          admission: {
            kind: expect.toBeOneOf(["available", "cleanup_pending"]),
          },
        });
      }
      fixture.fake.failClose = false;
      const gate =
        order === "resume-before-cleanup"
          ? blockProviderSession(
              fixture.fake,
              await providerSession(fixture, person.accepted.handle),
            )
          : null;
      const resume = {
        handle: person.accepted.handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      };
      const resuming = person.account.resume(
        person.principal,
        grant(person.principal, fixture.scope),
        resume,
      );
      if (gate) {
        try {
          await gate.wait();
          expect(await person.account.status(person.principal)).toMatchObject({
            generation: person.accepted.generation + 1,
            admission: { kind: "transfer_required" },
          });
        } finally {
          gate.release();
        }
      }
      const result = MediaOutcomeSchema.parse(await resuming);
      expect(result).toMatchObject({
        kind: "participation_ended",
        generation:
          person.accepted.generation +
          Number(order !== "notification-before-resume"),
        reason: "removed",
      });
      if (order !== "notification-before-resume")
        await restoreRemovalNotification(person);
      await runDurableObjectAlarm(fixture.media);
      await runDurableObjectAlarm(person.account);
      await interruptActors(fixture, person);
      expect(
        await person.account.resume(
          person.principal,
          grant(person.principal, fixture.scope),
          resume,
        ),
      ).toMatchObject({ kind: "participation_ended", reason: "removed" });
      expect(await person.account.status(person.principal)).toMatchObject({
        kind: "media_status",
        admission: { kind: "available" },
      });
      expect((await snapshot(fixture)).participants).toEqual([]);
      expect(forwardingCount(fixture.fake)).toBe(0);
      expect(
        fixture.fake.calls.filter((call) =>
          call.path.endsWith("/sessions/new"),
        ),
      ).toHaveLength(1);
    },
  );

  it("retains terminal closure after forwarding left and converges account cancellation without a browser", async () => {
    const fixture = setup();
    const person = await participant(fixture, "fixture-idle-removal");
    await publishParticipant(fixture, person);
    await interruptRemovalNotification(fixture, person);
    await interruptActors(fixture, person);
    await runDurableObjectAlarm(fixture.media);
    expect(forwardingCount(fixture.fake)).toBe(0);
    expect((await snapshot(fixture)).participants).toEqual([]);
    const close = {
      room: fixture.scope,
      participantId: person.accepted.handle.participantId,
      generation: person.accepted.generation,
      reason: "replace" as const,
    };
    expect(await fixture.media.endClaim(close)).toMatchObject({
      disposition: { kind: "terminal", reason: "removed" },
    });
    expect(
      await fixture.media.endClaim({ ...close, reason: "leave" }),
    ).toMatchObject({
      disposition: { kind: "terminal", reason: "removed" },
    });
    await restoreRemovalNotification(person);
    await interruptActors(fixture, person);
    expect(await runDurableObjectAlarm(fixture.media)).toBe(true);
    await runDurableObjectAlarm(person.account);
    // A due native alarm can already be executing when the helper checks it.
    await expect
      .poll(
        async () => {
          const status = await person.account.status(person.principal);
          return status.kind === "media_status"
            ? status.admission.kind
            : status.kind;
        },
        { timeout: 5_000, interval: 10 },
      )
      .toBe("available");
    expect(await person.account.status(person.principal)).toMatchObject({
      kind: "media_status",
      admission: { kind: "available" },
    });
    expect(await fixture.media.endClaim(close)).toMatchObject({
      kind: "closed",
      disposition: { kind: "terminal", reason: "removed" },
    });
  });

  it("keeps acknowledged operational closure immutable when a late Remove precedes Resume", async () => {
    const fixture = setup();
    const person = await participant(fixture, "fixture-late-remove");
    await publishParticipant(fixture, person);
    await runInDurableObject(fixture.media, (_instance, state) => {
      state.storage.sql.exec("UPDATE media_participants SET lease_expires=1");
    });
    await runDurableObjectAlarm(fixture.media);
    const close = {
      room: fixture.scope,
      participantId: person.accepted.handle.participantId,
      generation: person.accepted.generation,
      reason: "replace" as const,
    };
    expect(await fixture.media.endClaim(close)).toMatchObject({
      kind: "closed",
      disposition: { kind: "recoverable", reason: "lease_expired" },
    });
    expect(
      await fixture.media.moderate(
        fixture.principal,
        grant(fixture.principal, fixture.scope),
        await removalRequest(fixture, person),
      ),
    ).toMatchObject({ kind: "moderation_changed" });
    expect(await fixture.media.endClaim(close)).toMatchObject({
      kind: "closed",
      disposition: { kind: "recoverable", reason: "lease_expired" },
    });
    const fresh = joined(
      await person.account.resume(
        person.principal,
        grant(person.principal, fixture.scope),
        {
          handle: person.accepted.handle,
          nextDeviceToken: token(),
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
        },
      ),
    );
    expect(fresh.generation).toBe(person.accepted.generation + 1);
    expect(
      await fixture.media.heartbeat(
        person.principal,
        grant(person.principal, fixture.scope),
        { handle: fresh.handle },
      ),
    ).toMatchObject({ kind: "heartbeat" });
  });

  it("retains account intent when the short owner grant expires during real provider allocation", async () => {
    const fixture = setup();
    const person = await participant(fixture, "fixture-delayed-grant");
    const gate = barrier();
    fixture.fake.publishGate = gate.promise;
    const authorization = {
      ...grant(person.principal, fixture.scope),
      expiresAt: Date.now() + 1_000,
    };
    const publishing = fixture.media.publish(
      person.principal,
      authorization,
      publication(person.accepted.handle),
    );
    try {
      await expect
        .poll(() =>
          fixture.fake.calls.some((call) => call.path.endsWith("/tracks/new")),
        )
        .toBe(true);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, authorization.expiresAt - Date.now() + 10),
        ),
      );
    } finally {
      gate.release();
    }
    expect(await publishing).toMatchObject({ kind: "unavailable" });
    // A concurrent closure keeps its work slot after the publishing caller
    // returns. The durable cleanup still has to converge before readmission.
    await expect.poll(() => forwardingCount(fixture.fake)).toBe(0);
    expect((await snapshot(fixture)).participants).toEqual([]);
    expect(await person.account.status(person.principal)).toMatchObject({
      admission: { kind: "transfer_required" },
    });
    const fresh = joined(
      await person.account.resume(
        person.principal,
        grant(person.principal, fixture.scope),
        {
          handle: person.accepted.handle,
          nextDeviceToken: token(),
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
        },
      ),
    );
    expect(fresh.generation).toBe(person.accepted.generation + 1);
    expect(fresh.snapshot.participants).toMatchObject([
      { status: "active", publications: [] },
    ]);
  });

  it.each(["ack", "publish retry"] as const)(
    "requires a fresh participant target to lift mute after interrupted %s",
    async (completion) => {
      const fixture = setup();
      const person = await participant(fixture, "fixture-pending-mute");
      const command = publication(person.accepted.handle);
      const pending = await fixture.media.publish(
        person.principal,
        grant(person.principal, fixture.scope),
        command,
      );
      if (pending.kind !== "negotiation")
        throw new Error("Expected pending publication.");
      expect(pending.phase).toBe("awaiting_apply");
      expect(
        await fixture.media.moderate(
          fixture.principal,
          grant(fixture.principal, fixture.scope),
          { ...(await removalRequest(fixture, person)), action: "mute" },
        ),
      ).toMatchObject({ kind: "moderated", cleanupPending: false });
      expect(forwardingCount(fixture.fake)).toBe(0);
      // The ended displayed target cannot change inherited restrictions.
      expect(
        await fixture.media.moderate(
          fixture.principal,
          grant(fixture.principal, fixture.scope),
          {
            ...(await removalRequest(fixture, person)),
            action: "mute",
            enabled: false,
          },
        ),
      ).toMatchObject({ kind: "moderation_changed" });
      expect(
        (await snapshot(fixture)).participants.flatMap(
          (item) => item.publications,
        ),
      ).toEqual([]);
      const result =
        completion === "ack"
          ? await fixture.media.ack(
              person.principal,
              grant(person.principal, fixture.scope),
              {
                handle: person.accepted.handle,
                operationId: pending.operationId,
                expectedSessionVersion: pending.sessionVersion,
              },
            )
          : await fixture.media.publish(
              person.principal,
              grant(person.principal, fixture.scope),
              command,
            );
      expect(result.kind).toBe("recovery_required");
      expect((await snapshot(fixture)).participants).toEqual([]);
      expect(forwardingCount(fixture.fake)).toBe(0);
      expect(await person.account.status(person.principal)).toMatchObject({
        admission: { kind: "transfer_required" },
      });
      const fresh = joined(
        await person.account.resume(
          person.principal,
          grant(person.principal, fixture.scope),
          {
            handle: person.accepted.handle,
            nextDeviceToken: token(),
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          },
        ),
      );
      expect(fresh.snapshot.participants).toMatchObject([
        { muted: true, status: "active", publications: [] },
      ]);
      expect(
        await fixture.media.moderate(
          fixture.principal,
          grant(fixture.principal, fixture.scope),
          {
            ...(await removalRequest(fixture, { ...person, accepted: fresh })),
            action: "mute",
            enabled: false,
          },
        ),
      ).toMatchObject({ kind: "moderated" });
      const next = await fixture.media.publish(
        person.principal,
        grant(person.principal, fixture.scope),
        publication(fresh.handle, ["microphone"], fresh.producerVersion),
      );
      if (next.kind !== "negotiation")
        throw new Error("Expected a fresh publication after explicit unmute.");
      expect(
        await fixture.media.ack(
          person.principal,
          grant(person.principal, fixture.scope),
          {
            handle: fresh.handle,
            operationId: next.operationId,
            expectedSessionVersion: next.sessionVersion,
          },
        ),
      ).toMatchObject({ kind: "completed" });
      expect(forwardingCount(fixture.fake)).toBe(1);
    },
  );

  it("replays completed publication and ACK receipts after mute without reopening or ending participation", async () => {
    const fixture = setup();
    const person = await participant(fixture, "fixture-completed-mute");
    const command = publication(person.accepted.handle);
    const pending = await fixture.media.publish(
      person.principal,
      grant(person.principal, fixture.scope),
      command,
    );
    if (pending.kind !== "negotiation")
      throw new Error("Expected pending publication.");
    const ack = {
      handle: person.accepted.handle,
      operationId: pending.operationId,
      expectedSessionVersion: pending.sessionVersion,
    };
    const completed = MediaOutcomeSchema.parse(
      await fixture.media.ack(
        person.principal,
        grant(person.principal, fixture.scope),
        ack,
      ),
    );
    expect(completed.kind).toBe("completed");
    expect(
      await fixture.media.moderate(
        fixture.principal,
        grant(fixture.principal, fixture.scope),
        { ...(await removalRequest(fixture, person)), action: "mute" },
      ),
    ).toMatchObject({ kind: "moderated", cleanupPending: false });
    expect(
      await fixture.media.publish(
        person.principal,
        grant(person.principal, fixture.scope),
        command,
      ),
    ).toEqual(completed);
    expect(
      await fixture.media.ack(
        person.principal,
        grant(person.principal, fixture.scope),
        ack,
      ),
    ).toEqual(completed);
    expect(
      await fixture.media.publish(
        person.principal,
        grant(person.principal, fixture.scope),
        publication(
          person.accepted.handle,
          ["microphone"],
          pending.sessionVersion,
        ),
      ),
    ).toMatchObject({ kind: "action_restricted", restriction: "mute" });
    expect((await snapshot(fixture)).participants).toMatchObject([
      { status: "active", muted: true, publications: [] },
    ]);
    expect(forwardingCount(fixture.fake)).toBe(0);
    expect(
      fixture.fake.calls.filter((call) => call.path.endsWith("/tracks/new")),
    ).toHaveLength(1);
  });

  it.each(["during cleanup", "after cleanup"] as const)(
    "recovers a pending receiving answer after owner deafen %s",
    async (timing) => {
      const fixture = setup();
      const publisher = await participant(fixture, "fixture-deafen-publisher");
      const publications = await publishParticipant(fixture, publisher);
      const person = await participant(fixture, "fixture-deafen-receiver");
      const pending = await fixture.media.subscribe(
        person.principal,
        grant(person.principal, fixture.scope),
        {
          handle: person.accepted.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: 0,
          publicationIds: publications.publications.map((item) => item.id),
        },
      );
      if (pending.kind !== "negotiation")
        throw new Error("Expected pending receiving negotiation.");
      expect(pending.phase).toBe("awaiting_answer");
      const gate =
        timing === "during cleanup"
          ? blockProviderSession(
              fixture.fake,
              await providerSession(
                fixture,
                person.accepted.handle,
                "consumer",
              ),
              "close",
            )
          : null;
      const moderating = fixture.media.moderate(
        fixture.principal,
        grant(fixture.principal, fixture.scope),
        { ...(await removalRequest(fixture, person)), action: "deafen" },
      );
      let answering;
      try {
        if (gate) await gate.wait();
        else expect(await moderating).toMatchObject({ kind: "moderated" });
        answering = fixture.media.answer(
          person.principal,
          grant(person.principal, fixture.scope),
          {
            handle: person.accepted.handle,
            operationId: pending.operationId,
            expectedSessionVersion: pending.sessionVersion,
            sessionDescription: { type: "answer", sdp: "v=0\r\n" },
          },
        );
        if (gate)
          await expect
            .poll(
              async () =>
                (await snapshot(fixture)).participants.find(
                  (item) => item.id === person.accepted.handle.participantId,
                )?.status,
            )
            .toBeUndefined();
      } finally {
        gate?.release();
      }
      const result = MediaOutcomeSchema.parse(await answering);
      expect(
        timing === "during cleanup"
          ? result.kind === "recovery_required"
          : [
              "recovery_required",
              "stale_version",
              "negotiation_expired",
            ].includes(result.kind),
      ).toBe(true);
      expect(await moderating).toMatchObject({ kind: "moderated" });
      expect(
        [...fixture.fake.sessions.values()].flatMap((session) =>
          [...session.tracks.values()].filter(
            (track) => track.location === "remote",
          ),
        ),
      ).toEqual([]);
      const fresh = joined(
        await person.account.resume(
          person.principal,
          grant(person.principal, fixture.scope),
          {
            handle: person.accepted.handle,
            nextDeviceToken: token(),
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          },
        ),
      );
      expect(
        fresh.snapshot.participants.find(
          (item) => item.id === fresh.handle.participantId,
        ),
      ).toMatchObject({ status: "active", deafened: true, publications: [] });
      expect(forwardingCount(fixture.fake)).toBe(1);
    },
  );

  it.each(["resume"] as const)(
    "preserves accepted %s intent when its owner grant expires at the old-room closure barrier",
    async (operation) => {
      const fixture = setup();
      const person = await participant(fixture, "fixture-barrier-grant");
      await publishParticipant(fixture, person);
      const target = fixture.scope;
      const command = request(target, person.accepted.generation);
      const resume = {
        handle: person.accepted.handle,
        nextDeviceToken: command.deviceToken,
        commandId: command.commandId,
        issuedAt: command.issuedAt,
      };
      const begin = (authorization: ReturnType<typeof grant>) =>
        person.account[operation](person.principal, authorization, resume);
      const gate = blockProviderSession(
        fixture.fake,
        await providerSession(fixture, person.accepted.handle),
      );
      const authorization = {
        ...grant(person.principal, target),
        expiresAt: Date.now() + 1_000,
      };
      const beginning = begin(authorization);
      try {
        await gate.wait();
        expect(await person.account.status(person.principal)).toMatchObject({
          generation: person.accepted.generation + 1,
          admission: { kind: "transfer_required" },
        });
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, authorization.expiresAt - Date.now() + 10),
          ),
        );
      } finally {
        gate.release();
      }
      expect(await beginning).toMatchObject({ kind: "unavailable" });
      expect(forwardingCount(fixture.fake)).toBe(0);
      expect(
        fixture.fake.calls.filter((call) =>
          call.path.endsWith("/sessions/new"),
        ),
      ).toHaveLength(1);
      await runDurableObjectAlarm(person.account);
      await expect
        .poll(async () => {
          const status = await person.account.status(person.principal);
          return (
            status.kind === "media_status" &&
            status.admission.kind === "resumable"
          );
        })
        .toBe(true);
      const retry = MediaOutcomeSchema.parse(
        await begin(grant(person.principal, target)),
      );
      if (retry.kind !== "recovery_required")
        throw new Error(
          `Expected owned recovery after expired grant, got ${retry.kind}.`,
        );
      const fresh = joined(
        await person.account.resume(
          person.principal,
          grant(person.principal, target),
          {
            handle: retry.handle,
            nextDeviceToken: token(),
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          },
        ),
      );
      expect(fresh.generation).toBe(person.accepted.generation + 2);
      expect(fresh.handle.room).toEqual(target);
      expect(fresh.snapshot.participants).toMatchObject([
        { status: "active", publications: [] },
      ]);
    },
  );

  it.each(["join", "transfer"] as const)(
    "preserves explicit fresh %s after old removal and still checks current authorization",
    async (operation) => {
      const fixture = setup();
      const person = await participant(fixture, "fixture-explicit-intent");
      await publishParticipant(fixture, person);
      if (operation === "transfer") {
        await interruptRemovalNotification(fixture, person);
        await restoreRemovalNotification(person);
      } else {
        expect(
          await fixture.media.moderate(
            fixture.principal,
            grant(fixture.principal, fixture.scope),
            await removalRequest(fixture, person),
          ),
        ).toMatchObject({ kind: "moderated" });
        await runDurableObjectAlarm(person.account);
      }
      const status = await person.account.status(person.principal);
      if (status.kind !== "media_status")
        throw new Error("Expected account media status.");
      const command = request(fixture.scope, status.generation);
      expect(
        await person.account[operation](
          person.principal,
          { ...grant(person.principal, fixture.scope), canJoin: false },
          command,
        ),
      ).toMatchObject({ kind: "forbidden" });
      expect(
        fixture.fake.calls.filter((call) =>
          call.path.endsWith("/sessions/new"),
        ),
      ).toHaveLength(1);
      const fresh = joined(
        await person.account[operation](
          person.principal,
          grant(person.principal, fixture.scope),
          command,
        ),
      );
      await person.account.recordRemoval(
        fixture.scope,
        person.accepted.generation,
      );
      await interruptActors(fixture, person);
      await runDurableObjectAlarm(fixture.media);
      expect(await person.account.status(person.principal)).toMatchObject({
        generation: fresh.generation,
        admission: { kind: "transfer_required", room: fixture.scope },
      });
      expect(
        await fixture.media.heartbeat(
          person.principal,
          grant(person.principal, fixture.scope),
          { handle: fresh.handle },
        ),
      ).toMatchObject({ kind: "heartbeat" });
    },
  );

  it("returns recovery only to the complete owning capability after an operational close", async () => {
    const fixture = setup();
    const person = await participant(fixture, "fixture-private-recovery");
    await publishParticipant(fixture, person);
    await runInDurableObject(fixture.media, (_instance, state) => {
      state.storage.sql.exec("UPDATE media_participants SET lease_expires=1");
    });
    await runDurableObjectAlarm(fixture.media);
    await evictDurableObject(fixture.media);
    await evictDurableObject(person.account);
    const recovered = MediaOutcomeSchema.parse(
      await fixture.media.heartbeat(
        person.principal,
        grant(person.principal, fixture.scope),
        { handle: person.accepted.handle },
      ),
    );
    expect(recovered).toMatchObject({
      kind: "recovery_required",
      handle: person.accepted.handle,
      reason: "lease_expired",
    });
    const invalid = [
      { ...person.accepted.handle, deviceToken: token() },
      { ...person.accepted.handle, clientId: crypto.randomUUID() },
      { ...person.accepted.handle, participantId: "another-participant" },
      {
        ...person.accepted.handle,
        room: { ...fixture.scope, channelId: crypto.randomUUID() },
      },
    ];
    for (const handle of invalid) {
      const result = MediaOutcomeSchema.parse(
        await fixture.media.heartbeat(
          person.principal,
          grant(person.principal, fixture.scope),
          { handle },
        ),
      );
      expect(result.kind).toBe("forbidden");
      expect("handle" in result).toBe(false);
      expect(
        JSON.stringify(result).includes(person.accepted.handle.deviceToken),
      ).toBe(false);
    }
    const stranger = user();
    const result = MediaOutcomeSchema.parse(
      await fixture.media.heartbeat(stranger, grant(stranger, fixture.scope), {
        handle: person.accepted.handle,
      }),
    );
    expect("handle" in result).toBe(false);
    expect(
      JSON.stringify(result).includes(person.accepted.handle.deviceToken),
    ).toBe(false);
    expect(forwardingCount(fixture.fake)).toBe(0);
  });
});
