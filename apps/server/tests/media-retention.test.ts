import { barrier } from "@tests/helpers/barrier";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MEDIA_TERMINAL_RETENTION_MS } from "@/server/actors/media/retention";
import { mediaNetwork, mediaNetworkProbe } from "@tests/helpers/media-network";
import {
  forwardingCount,
  interruptActors,
  interruptRemovalNotification,
  participant,
  publishParticipant,
  restoreRemovalNotification,
} from "@tests/helpers/media-lifecycle";
import {
  grant,
  joined,
  publication,
  publishReady,
  request,
  setup,
  token,
} from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
afterEach(() => {
  mediaNetwork.resetHandlers();
  expect(mediaNetworkProbe.blocked).toBe(0);
  expect(mediaNetworkProbe.failures).toBe(0);
  expect(mediaNetworkProbe.interceptorFailures).toBe(0);
});
afterAll(async () => {
  // Terminate isolated actors before removing their provider interception.
  await abortAllDurableObjects();
  await mediaNetwork.disable();
});

const oldClosure = () => Date.now() - MEDIA_TERMINAL_RETENTION_MS - 1_000;
function details(s: ReturnType<typeof setup>) {
  return runInDurableObject(
    s.media,
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT
    (SELECT COUNT(*) FROM media_participants) +
    (SELECT COUNT(*) FROM media_sessions) +
    (SELECT COUNT(*) FROM media_operations) +
    (SELECT COUNT(*) FROM media_publications) +
    (SELECT COUNT(*) FROM media_allocations) +
    (SELECT COUNT(*) FROM media_subscriptions) AS count`,
        )
        .one().count,
  );
}

describe("bounded room retention on real workerd actors", () => {
  it("bounds the entire cleanup transaction, rolls it back on failure, and keeps the latest closed generation from being readmitted by an exact retry", async () => {
    const s = setup();
    const firstCommand = request(s.scope);
    const first = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        firstCommand,
      ),
    );
    await publishReady(s, first.handle);
    const left = await s.account.leave(s.principal, {
      handle: first.handle,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    });
    if (left.kind !== "left") throw new Error("Expected Leave.");
    const currentCommand = request(s.scope, left.generation);
    const current = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        currentCommand,
      ),
    );
    await publishReady(s, current.handle);
    await s.media.endClaim({
      room: s.scope,
      participantId: current.handle.participantId,
      generation: current.generation,
      reason: "replace",
    });
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET closed_at=?",
        oldClosure(),
      );
      state.storage.transactionSync(() => {
        for (let index = 0; index < 250; index++)
          state.storage.sql.exec(
            "INSERT INTO media_operations(participant_id,generation,direction,operation_id,payload_hash,created_at) VALUES(?,?,'producer',?,'fixture',1)",
            first.handle.participantId,
            first.generation,
            `old-${index}`,
          );
      });
    });
    const before = await details(s);
    expect(await runDurableObjectAlarm(s.media)).toBe(true);
    expect(before - (await details(s))).toBe(200);
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fixture_retention_failure BEFORE DELETE ON media_sessions BEGIN SELECT RAISE(ABORT, 'fixture retention interruption'); END",
      );
    });
    const interrupted = await details(s);
    await expect(runDurableObjectAlarm(s.media)).rejects.toThrow(
      "fixture retention interruption",
    );
    expect(await details(s)).toBe(interrupted);
    await runInDurableObject(s.media, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec("DROP TRIGGER fixture_retention_failure");
    });
    await evictDurableObject(s.media);
    expect(await runDurableObjectAlarm(s.media)).toBe(true);
    expect(await details(s)).toBe(1);
    const allocations = s.fake.calls.filter((call) =>
      call.path.endsWith("/sessions/new"),
    ).length;
    expect(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        currentCommand,
      ),
    ).toMatchObject({ kind: "recovery_required", handle: current.handle });
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/sessions/new")),
    ).toHaveLength(allocations);
    expect(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        firstCommand,
      ),
    ).toMatchObject({
      kind: "stale_generation",
      currentGeneration: current.generation,
    });
    expect(
      await s.media.heartbeat(s.principal, grant(s.principal, s.scope), {
        handle: first.handle,
      }),
    ).toMatchObject({ kind: "stale_generation" });
    expect(forwardingCount(s.fake)).toBe(0);
  });

  it("rearms current retained state after eviction, waits for removal acknowledgement, and preserves terminal intent after details expire", async () => {
    const s = setup();
    const person = await participant(s, "retention-removed-account");
    await publishParticipant(s, person);
    await interruptRemovalNotification(s, person);
    await interruptActors(s, person);
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET closed_at=?",
        oldClosure(),
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(await details(s)).toBeGreaterThan(1);
    await restoreRemovalNotification(person);
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET cleanup_at=1 WHERE cleanup_at IS NOT NULL",
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(await person.account.status(person.principal)).toMatchObject({
      admission: {
        kind: expect.toBeOneOf(["available", "cleanup_pending"]),
      },
    });
    await runDurableObjectAlarm(person.account);
    const closedAt = await runInDurableObject(
      s.media,
      async (_instance, state) => {
        const participant = state.storage.sql
          .exec<{
            status: string;
            cancellation_pending: number;
            closed_at: number;
          }>(
            "SELECT status,cancellation_pending,closed_at FROM media_participants",
          )
          .one();
        expect(participant).toMatchObject({
          status: "left",
          cancellation_pending: 0,
        });
        expect(participant.closed_at).toBeGreaterThan(
          oldClosure() + MEDIA_TERMINAL_RETENTION_MS - 5_000,
        );
        expect(
          state.storage.sql.exec("SELECT phase FROM media_sessions").toArray(),
        ).toEqual([{ phase: "closed" }, { phase: "closed" }]);
        // Recover a lost scheduled wake from current durable retention state.
        await state.storage.deleteAlarm();
        return participant.closed_at;
      },
    );
    await interruptActors(s, person);
    await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
      room: s.scope,
    });
    await runInDurableObject(s.media, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(closedAt + MEDIA_TERMINAL_RETENTION_MS);
      expect(
        state.storage.sql
          .exec("SELECT closed_at FROM media_participants")
          .one(),
      ).toEqual({ closed_at: closedAt });
    });
    const future = Date.now() + 20_000;
    await runInDurableObject(s.media, async (_instance, state) => {
      await state.storage.setAlarm(future);
    });
    await evictDurableObject(s.media);
    await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
      room: s.scope,
    });
    await runInDurableObject(s.media, async (_instance, state) => {
      const refreshed = await state.storage.getAlarm();
      expect(refreshed).toBeGreaterThan(future);
      expect(refreshed).toBeLessThanOrEqual(
        closedAt + MEDIA_TERMINAL_RETENTION_MS,
      );
    });
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET closed_at=?",
        oldClosure(),
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(await details(s)).toBe(1);
    expect(
      await person.account.resume(
        person.principal,
        grant(person.principal, s.scope),
        {
          handle: person.accepted.handle,
          nextDeviceToken: token(),
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
        },
      ),
    ).toMatchObject({ kind: "participation_ended", reason: "removed" });
  });

  it("closes failed idless allocations before retention and preserves their generation fence through eviction", async () => {
    const s = setup();
    const command = request(s.scope);
    const provider = s.fake.fetcher;
    let allocations = 0;
    s.fake.fetcher = async (input, init) => {
      const outgoing = new Request(input, init);
      if (new URL(outgoing.url).pathname.endsWith("/sessions/new")) {
        allocations++;
        return Response.json({ errorCode: "backend_error" }, { status: 503 });
      }
      return provider(input, init);
    };
    const accepted = joined(
      await s.account.join(s.principal, grant(s.principal, s.scope), command),
    );
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle),
      ),
    ).toMatchObject({ kind: "provider_error" });
    expect(allocations).toBe(1);
    await runInDurableObject(s.media, async (_instance, state) => {
      const participant = state.storage.sql
        .exec<{ status: string; closed_at: number }>(
          "SELECT status,closed_at FROM media_participants",
        )
        .one();
      expect(participant.status).toBe("left");
      expect(participant.closed_at).toBeGreaterThan(0);
      expect(
        state.storage.sql
          .exec("SELECT provider_id,phase FROM media_sessions")
          .toArray(),
      ).toEqual([
        { provider_id: null, phase: "closed" },
        { provider_id: null, phase: "closed" },
      ]);
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec(
        "UPDATE media_participants SET closed_at=?",
        oldClosure(),
      );
    });
    await evictDurableObject(s.media);
    await runDurableObjectAlarm(s.media);
    expect(await details(s)).toBe(1);
    expect(
      await s.account.join(s.principal, grant(s.principal, s.scope), command),
    ).toMatchObject({ kind: "recovery_required", reason: "transport_closed" });
    expect(allocations).toBe(1);
    expect(forwardingCount(s.fake)).toBe(0);
  });

  it("keeps aged receipts and allocation state while a provider response and failed closure remain unsettled", async () => {
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
    s.fake.failClose = true;
    const publishing = s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      publication(accepted.handle),
    );
    await expect
      .poll(() =>
        s.fake.calls.some((call) => call.path.endsWith("/tracks/new")),
      )
      .toBe(true);
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET lease_expires=1,closed_at=?",
        oldClosure(),
      );
      state.storage.sql.exec("UPDATE media_operations SET created_at=1");
    });
    const closing = runDurableObjectAlarm(s.media);
    try {
      await expect
        .poll(() =>
          runInDurableObject(
            s.media,
            (_instance, state) =>
              state.storage.sql
                .exec("SELECT status FROM media_participants")
                .one().status,
          ),
        )
        .toBe("closing");
      await runInDurableObject(s.media, (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_operations")
            .one(),
        ).toEqual({ count: 1 });
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_allocations")
            .one(),
        ).toEqual({ count: 1 });
      });
    } finally {
      gate.release();
      await publishing;
      await closing;
    }
    await evictDurableObject(s.media);
    await runDurableObjectAlarm(s.media);
    expect(forwardingCount(s.fake)).toBe(1);
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM media_operations")
          .one(),
      ).toEqual({ count: 1 });
      expect(
        state.storage.sql.exec("SELECT status FROM media_participants").one(),
      ).toEqual({ status: "closing" });
    });
    s.fake.failClose = false;
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET cleanup_at=1 WHERE cleanup_at IS NOT NULL",
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(forwardingCount(s.fake)).toBe(0);
    await runInDurableObject(s.media, (_instance, state) => {
      const closed = state.storage.sql
        .exec<{ closed_at: number }>("SELECT closed_at FROM media_participants")
        .one();
      expect(closed.closed_at).toBeGreaterThan(
        oldClosure() + MEDIA_TERMINAL_RETENTION_MS - 5_000,
      );
      state.storage.sql.exec(
        "UPDATE media_participants SET closed_at=?",
        oldClosure(),
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(await details(s)).toBe(1);
  });

  it("keeps a live consumer's close descriptor when the source publication is pruned", async () => {
    const s = setup();
    s.fake.remoteRequiresRenegotiation = false;
    const publisher = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const published = await publishReady(s, publisher.handle);
    const receiver = await participant(s, "retention-live-consumer");
    expect(
      await s.media.subscribe(
        receiver.principal,
        grant(receiver.principal, s.scope),
        {
          handle: receiver.accepted.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: 0,
          publicationIds: published.publications.map(
            (publication) => publication.id,
          ),
        },
      ),
    ).toMatchObject({ kind: "completed" });
    await s.media.endClaim({
      room: s.scope,
      participantId: publisher.handle.participantId,
      generation: publisher.generation,
      reason: "replace",
    });
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET closed_at=? WHERE id=?",
        oldClosure(),
        publisher.handle.participantId,
      );
    });
    await runDurableObjectAlarm(s.media);
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM media_publications")
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM media_subscriptions")
          .one(),
      ).toEqual({ count: 1 });
    });
    expect(forwardingCount(s.fake)).toBe(1);
    expect(
      await s.media.subscribe(
        receiver.principal,
        grant(receiver.principal, s.scope),
        {
          handle: receiver.accepted.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: 1,
          publicationIds: [],
        },
      ),
    ).toMatchObject({ kind: "completed", subscriptions: [] });
    // Ordinary removal closes the receiver even after its source details were pruned.
    expect(forwardingCount(s.fake)).toBe(0);
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM media_subscriptions")
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM media_allocations")
          .one(),
      ).toEqual({ count: 0 });
    });
  });
});
