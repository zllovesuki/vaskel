import { observeSql } from "@tests/helpers/sql-observer";
import { moderationTarget } from "@tests/helpers/media-room";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import { reserve } from "@/server/actors/media/operations";
import {
  MEDIA_TERMINAL_RETENTION_MS,
  pruneMediaRecords,
} from "@/server/actors/media/retention";
import {
  openMediaDatabase,
  sessionKey,
  type RoomRuntime,
} from "@/server/actors/media/store";
import { RealtimeClient } from "@/server/providers/realtime";
import { mediaNetwork, mediaNetworkProbe } from "@tests/helpers/media-network";
import {
  blockProviderSession,
  providerSession,
  snapshot,
} from "@tests/helpers/media-lifecycle";
import {
  grant,
  joined,
  publication,
  publishReady,
  request,
  setup,
  user,
} from "@tests/helpers/media-room";

beforeAll(async () => {
  expect(env.REALTIME_APP_ID === "fixture-app").toBe(true);
  expect(env.REALTIME_APP_SECRET === "fixture-secret").toBe(true);
  await mediaNetwork.enable();
});
afterEach(() => {
  mediaNetwork.resetHandlers();
  expect(mediaNetworkProbe.blocked).toBe(0);
  expect(mediaNetworkProbe.failures).toBe(0);
  expect(mediaNetworkProbe.interceptorFailures).toBe(0);
});
afterAll(async () => {
  await mediaNetwork.disable();
});

describe("moderation ownership and retained command recovery", () => {
  it("returns busy after one recheck when a settled scope leaves moderation owned and the clock is frozen", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await runInDurableObject(s.media, async (instance, state) => {
      const rt = (instance as unknown as { runtime: RoomRuntime }).runtime;
      const p = await rt.db
        .selectFrom("media_participants")
        .selectAll()
        .where("id", "=", accepted.handle.participantId)
        .where("generation", "=", accepted.handle.accountGeneration)
        .executeTakeFirstOrThrow();
      const key = sessionKey(p.id, p.generation, "producer");
      const operationId = crypto.randomUUID();
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE media_sessions SET phase='moderating',operation_id=?,deadline=? WHERE session_key=?",
        operationId,
        now + 10_000,
        key,
      );
      const scope = Promise.resolve();
      const then = scope.then.bind(scope);
      const wait = vi.spyOn(scope, "then");
      wait.mockImplementationOnce(then).mockImplementation(() => {
        throw new Error("A settled moderation scope was awaited again.");
      });
      rt.inflight.set(`scope:${key}`, scope);
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        expect(
          await reserve(
            rt,
            s.principal,
            grant(s.principal, s.scope),
            p,
            "producer",
            publication(accepted.handle),
          ),
        ).toEqual({ kind: "session_busy", operationId });
        expect(wait).toHaveBeenCalledTimes(1);
        expect(
          state.storage.sql
            .exec<{ phase: string; operation_id: string }>(
              "SELECT phase,operation_id FROM media_sessions WHERE session_key=?",
              key,
            )
            .one(),
        ).toEqual({ phase: "moderating", operation_id: operationId });
      } finally {
        clock.mockRestore();
        wait.mockRestore();
        rt.inflight.delete(`scope:${key}`);
        state.storage.sql.exec(
          "UPDATE media_sessions SET phase='idle',operation_id=NULL,deadline=0 WHERE session_key=?",
          key,
        );
      }
    });
  });

  it("serializes a delayed deafen close before a newer subscription and recovers its pending receipt", async () => {
    const s = setup();
    s.fake.remoteRequiresRenegotiation = false;
    const publisher = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const published = await publishReady(s, publisher.handle, [
      "microphone",
      "camera",
    ]);
    const listener = user();
    const receiver = joined(
      await env.ACCOUNT_MEDIA.getByName(listener.userId).join(
        listener,
        grant(listener, s.scope),
        request(s.scope),
      ),
    );
    const first = MediaOutcomeSchema.parse(
      await s.media.subscribe(listener, grant(listener, s.scope), {
        handle: receiver.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        publicationIds: [published.publications[0]!.id],
      }),
    );
    if (first.kind !== "completed")
      throw new Error(`Unexpected first subscription ${first.kind}`);
    expect(first.subscriptions).toHaveLength(1);
    const consumerId = await providerSession(s, receiver.handle, "consumer");
    const gate = blockProviderSession(s.fake, consumerId, "close");
    const deafenCommand = {
      room: s.scope,
      userId: listener.userId,
      action: "deafen" as const,
      enabled: true,
      commandId: crypto.randomUUID(),
      ...moderationTarget(await snapshot(s), listener.userId),
    };
    const deafening = s.media.moderate(
      s.principal,
      grant(s.principal, s.scope),
      deafenCommand,
    );
    let subscribing: ReturnType<typeof s.media.subscribe> | undefined;
    let subscriptionSettled = false;
    try {
      await gate.wait();
      const restricted = await snapshot(s);
      expect(
        restricted.participants.find((p) => p.id === listener.userId)?.deafened,
      ).toBe(true);
      expect(
        await s.media.moderate(s.principal, grant(s.principal, s.scope), {
          ...deafenCommand,
          commandId: crypto.randomUUID(),
          enabled: false,
          ...moderationTarget(restricted, listener.userId),
        }),
      ).toMatchObject({ kind: "moderated", cleanupPending: false });
      const calls = s.fake.calls.length;
      expect(
        await s.media.moderate(
          s.principal,
          grant(s.principal, s.scope),
          deafenCommand,
        ),
      ).toEqual({
        kind: "moderated",
        revision: restricted.revision,
        cleanupPending: true,
      });
      subscribing = s.media.subscribe(listener, grant(listener, s.scope), {
        handle: receiver.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: first.sessionVersion,
        publicationIds: published.publications.map((p) => p.id),
      });
      void subscribing.then(() => {
        subscriptionSettled = true;
      });
      expect(s.fake.calls).toHaveLength(calls);
      expect(
        await runInDurableObject(
          s.media,
          (_instance, state) =>
            state.storage.sql
              .exec<{ phase: string }>(
                "SELECT phase FROM media_sessions WHERE provider_id=?",
                consumerId,
              )
              .one().phase,
        ),
      ).toBe("moderating");
      expect(subscriptionSettled).toBe(false);
    } finally {
      gate.release();
      expect(await deafening).toMatchObject({
        kind: "moderated",
        cleanupPending: false,
      });
    }
    const next = MediaOutcomeSchema.parse(await subscribing);
    expect(next).toMatchObject({ kind: "completed", sessionVersion: 2 });
    if (next.kind !== "completed")
      throw new Error("Expected subscription completion");
    expect(next.subscriptions).toHaveLength(2);
    expect(s.fake.sessions.get(consumerId)!.tracks.size).toBe(2);
    expect(
      await runInDurableObject(
        s.media,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM media_subscriptions WHERE session_key=(SELECT session_key FROM media_sessions WHERE provider_id=?)",
              consumerId,
            )
            .one().count,
      ),
    ).toBe(2);
    expect(
      (await snapshot(s)).participants.find((p) => p.id === listener.userId)
        ?.deafened,
    ).toBe(false);
  });

  it("scopes conflicts to target controls across subscription completion, unrelated activity and replacement", async () => {
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
    const listener = user();
    const receiver = joined(
      await env.ACCOUNT_MEDIA.getByName(listener.userId).join(
        listener,
        grant(listener, s.scope),
        request(s.scope),
      ),
    );
    const shown = await snapshot(s);
    const subscribed = await s.media.subscribe(
      listener,
      grant(listener, s.scope),
      {
        handle: receiver.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        publicationIds: [published.publications[0]!.id],
      },
    );
    expect(subscribed).toMatchObject({
      kind: "completed",
      revision: shown.revision,
    });
    expect((await snapshot(s)).revision).toBe(shown.revision);
    const command = {
      room: s.scope,
      userId: s.principal.userId,
      action: "mute" as const,
      enabled: true,
      commandId: crypto.randomUUID(),
      ...moderationTarget(shown, s.principal.userId),
    };
    const unrelated = {
      ...command,
      userId: listener.userId,
      action: "deafen" as const,
      enabled: false,
      commandId: crypto.randomUUID(),
      ...moderationTarget(shown, listener.userId),
    };
    const unchanged = await s.media.moderate(
      s.principal,
      grant(s.principal, s.scope),
      unrelated,
    );
    expect(unchanged).toMatchObject({ kind: "moderated" });
    expect(
      await s.media.moderate(
        s.principal,
        grant(s.principal, s.scope),
        unrelated,
      ),
    ).toEqual(unchanged);
    expect(
      moderationTarget(await snapshot(s), listener.userId)
        .expectedControlVersion,
    ).toBe(1);
    const accepted = await runInDurableObject(
      s.media,
      async (instance, state) => {
        const observed = await observeSql(state.storage.sql, () =>
          instance.moderate(s.principal, grant(s.principal, s.scope), command),
        );
        const lookup = observed.statements.find(
          (statement) =>
            /^select /i.test(statement.query) &&
            statement.query.includes('"media_participants"') &&
            statement.query.includes('"user_id"'),
        )!;
        const plan = state.storage.sql
          .exec(
            `EXPLAIN QUERY PLAN ${lookup.query}`,
            ...(lookup.bindings as SqlStorageValue[]),
          )
          .toArray();
        expect(plan.map((row) => row.detail).join(" ")).toContain(
          "media_participant_generation",
        );
        return observed.value;
      },
    );
    expect(accepted).toMatchObject({ kind: "moderated" });
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), {
        ...command,
        commandId: crypto.randomUUID(),
        enabled: false,
      }),
    ).toEqual({ kind: "moderation_changed" });
    const current = await snapshot(s);
    expect(
      moderationTarget(current, s.principal.userId).expectedControlVersion,
    ).toBe(1);
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), {
        ...unrelated,
        commandId: crypto.randomUUID(),
        ...moderationTarget(current, listener.userId),
      }),
    ).toMatchObject({ kind: "moderated" });
    expect(
      moderationTarget(await snapshot(s), listener.userId)
        .expectedControlVersion,
    ).toBe(2);
    const left = await s.account.leave(s.principal, {
      handle: publisher.handle,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    });
    if (left.kind !== "left") throw new Error(left.kind);
    const replacement = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope, left.generation),
      ),
    );
    expect(
      moderationTarget(replacement.snapshot, s.principal.userId)
        .expectedControlVersion,
    ).toBe(0);
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), command),
    ).toEqual(accepted);
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), {
        ...command,
        commandId: crypto.randomUUID(),
        expectedControlVersion: 1,
        action: "remove",
      }),
    ).toEqual({ kind: "moderation_changed" });
  });

  it("recovers exact moderation after eviction, rejects conflicting payloads, and retains fresh authorization", async () => {
    const s = setup();
    const publisher = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, publisher.handle);
    const command = {
      room: s.scope,
      userId: s.principal.userId,
      action: "mute" as const,
      enabled: true,
      commandId: crypto.randomUUID(),
      ...moderationTarget(await snapshot(s), s.principal.userId),
    };
    const accepted = await s.media.moderate(
      s.principal,
      grant(s.principal, s.scope),
      command,
    );
    expect(accepted).toMatchObject({
      kind: "moderated",
      cleanupPending: false,
    });
    const callsAfterFirst = s.fake.calls.length;
    await evictDurableObject(s.media);
    const exactReplay = await s.media.moderate(
      s.principal,
      grant(s.principal, s.scope),
      command,
    );
    expect(exactReplay).toEqual(accepted);
    expect(s.fake.calls).toHaveLength(callsAfterFirst);
    const changedPayloadSameId = await s.media.moderate(
      s.principal,
      grant(s.principal, s.scope),
      {
        ...command,
        enabled: false,
        ...moderationTarget(await snapshot(s), s.principal.userId),
      },
    );
    expect(changedPayloadSameId).toEqual({ kind: "command_conflict" });
    expect(
      await s.media.moderate(
        s.principal,
        { ...grant(s.principal, s.scope), canModerate: false },
        command,
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      await s.media.moderate(
        { ...s.principal, expiresAt: Date.now() - 1 },
        grant(s.principal, s.scope),
        command,
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(s.fake.calls).toHaveLength(callsAfterFirst);
    await runInDurableObject(s.media, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_moderation_receipts SET created_at=?",
        Date.now() - MEDIA_TERMINAL_RETENTION_MS - 1,
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), command),
    ).toMatchObject({ kind: "moderation_changed" });
    expect(s.fake.calls).toHaveLength(callsAfterFirst);
  });

  it("recovers a completed exact publication at 91 seconds with fresh authority before rejecting new or compacted commands", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const command = publication(accepted.handle);
    const pending = await s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      command,
    );
    if (pending.kind !== "negotiation")
      throw new Error(`Unexpected publication ${pending.kind}`);
    const completion = await s.media.ack(
      s.principal,
      grant(s.principal, s.scope),
      {
        handle: accepted.handle,
        operationId: command.operationId,
        expectedSessionVersion: pending.sessionVersion,
      },
    );
    expect(completion).toMatchObject({ kind: "completed" });
    expect(
      await s.media.publish(s.principal, grant(s.principal, s.scope), command),
    ).toEqual(completion);
    const callsBefore = s.fake.calls.length;
    await runInDurableObject(s.media, async (instance, state) => {
      const realNow = Date.now;
      const simulatedNow = command.issuedAt + 91_000;
      Date.now = () => simulatedNow;
      try {
        const freshPrincipal = {
          ...s.principal,
          expiresAt: simulatedNow + 60_000,
        };
        const freshGrant = grant(freshPrincipal, s.scope);
        const heartbeat = await instance.heartbeat(freshPrincipal, freshGrant, {
          handle: accepted.handle,
        });
        expect(heartbeat.kind).toBe("heartbeat");
        const retained = state.storage.sql
          .exec<{ result: string; created_at: number }>(
            "SELECT result,created_at FROM media_operations WHERE operation_id=?",
            command.operationId,
          )
          .one();
        expect(JSON.parse(retained.result)).toEqual(completion);
        const retry = await instance.publish(
          freshPrincipal,
          freshGrant,
          command,
        );
        expect(retry).toEqual(completion);
        expect(
          await instance.publish(freshPrincipal, freshGrant, {
            ...command,
            expectedSessionVersion: command.expectedSessionVersion + 1,
          }),
        ).toEqual({ kind: "command_conflict" });
        expect(
          await instance.publish(freshPrincipal, freshGrant, {
            ...command,
            operationId: crypto.randomUUID(),
          }),
        ).toEqual({ kind: "command_expired" });
        expect(
          await instance.publish(
            { ...freshPrincipal, expiresAt: simulatedNow - 1 },
            freshGrant,
            command,
          ),
        ).toEqual({ kind: "unauthenticated" });
        expect(
          await instance.publish(
            freshPrincipal,
            { ...freshGrant, expiresAt: simulatedNow - 1 },
            command,
          ),
        ).toEqual({ kind: "unavailable" });
        expect(
          await instance.publish(freshPrincipal, freshGrant, {
            ...command,
            handle: {
              ...command.handle,
              accountGeneration: command.handle.accountGeneration + 1,
            },
          }),
        ).not.toEqual(completion);
        state.storage.sql.exec(
          "UPDATE media_operations SET created_at=? WHERE operation_id=?",
          simulatedNow - MEDIA_TERMINAL_RETENTION_MS - 1,
          command.operationId,
        );
        pruneMediaRecords(
          {
            ctx: state,
            env,
            db: openMediaDatabase(state.storage),
            provider: new RealtimeClient(env),
            inflight: new Map(),
          },
          simulatedNow,
        );
        expect(
          await instance.publish(freshPrincipal, freshGrant, command),
        ).toEqual({ kind: "command_expired" });
        const session = state.storage.sql
          .exec<{ version: number; phase: string }>(
            "SELECT version,phase FROM media_sessions WHERE participant_id=? AND direction='producer'",
            accepted.handle.participantId,
          )
          .one();
        expect(session).toEqual({
          version: pending.sessionVersion,
          phase: "idle",
        });
      } finally {
        Date.now = realNow;
      }
    });
    expect(s.fake.calls).toHaveLength(callsBefore);
  });
  it("expires pending offers even when their negotiation receipts remain retained", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const command = publication(accepted.handle);
    const pending = await s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      command,
    );
    if (pending.kind !== "negotiation") throw new Error("Expected negotiation");
    const calls = s.fake.calls.length;
    await runInDurableObject(s.media, async (instance) => {
      const realNow = Date.now;
      try {
        for (const [age, kind] of [
          [pending.deadline - command.issuedAt + 1, "negotiation_expired"],
          [91_000, "command_expired"],
        ] as const) {
          Date.now = () => command.issuedAt + age;
          const principal = { ...s.principal, expiresAt: Date.now() + 60_000 };
          expect(
            await instance.publish(
              principal,
              grant(principal, s.scope),
              command,
            ),
          ).toEqual({ kind });
        }
      } finally {
        Date.now = realNow;
      }
    });
    expect(s.fake.calls).toHaveLength(calls);
  });

  it("shares a rollback-safe 200-row retention budget between negotiation and moderation receipts while retaining current receipts", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle);
    await runInDurableObject(s.media, (_instance, state) => {
      const rt = {
        ctx: state,
        env,
        db: openMediaDatabase(state.storage),
        provider: new RealtimeClient(env),
        inflight: new Map<string, Promise<unknown>>(),
      };
      const now = Date.now();
      const old = now - MEDIA_TERMINAL_RETENTION_MS - 1;
      state.storage.transactionSync(() => {
        for (let i = 0; i < 250; i++)
          state.storage.sql.exec(
            "INSERT INTO media_operations(participant_id,generation,direction,operation_id,payload_hash,created_at) VALUES (?,?,'producer',?,'fixture',?)",
            s.principal.userId,
            i + 100,
            crypto.randomUUID(),
            old,
          );
        for (let i = 0; i < 205; i++)
          state.storage.sql.exec(
            "INSERT INTO media_moderation_receipts VALUES(?,?,?, ?,?)",
            s.principal.userId,
            String(i),
            "fixture",
            JSON.stringify({
              kind: "moderated",
              revision: i,
              cleanupPending: false,
            }),
            old,
          );
      });
      const count = () =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT (SELECT COUNT(*) FROM media_operations) + (SELECT COUNT(*) FROM media_moderation_receipts) AS count",
          )
          .one().count;
      expect(count()).toBe(456);
      pruneMediaRecords(rt, now);
      expect(count()).toBe(256);
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM media_operations WHERE created_at=?",
            old,
          )
          .one(),
      ).toEqual({ count: 50 });
      state.storage.sql.exec(
        "CREATE TRIGGER reject_receipt_prune BEFORE DELETE ON media_moderation_receipts BEGIN SELECT RAISE(ABORT,'fixture retention rollback'); END",
      );
      expect(() => pruneMediaRecords(rt, now)).toThrow(
        "fixture retention rollback",
      );
      expect(count()).toBe(256);
      state.storage.sql.exec("DROP TRIGGER reject_receipt_prune");
      pruneMediaRecords(rt, now);
      expect(count()).toBe(56);
      pruneMediaRecords(rt, now);
      expect(count()).toBe(1);
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM media_operations WHERE created_at>?",
            old,
          )
          .one(),
      ).toEqual({ count: 1 });
    });
  });
});
