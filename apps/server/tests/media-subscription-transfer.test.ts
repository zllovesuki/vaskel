import type { MediaSource } from "@vaskel/contracts/media";
import { barrier } from "@tests/helpers/barrier";
import { observeSql } from "@tests/helpers/sql-observer";
import { sessionKey, type RoomRuntime } from "@/server/actors/media/store";
import { pruneMediaRecords } from "@/server/actors/media/retention";
import { moderationTarget } from "@tests/helpers/media-room";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_CONSUMER_ALLOCATIONS } from "@/server/actors/media/negotiation/subscriptions";
import { mediaNetwork } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  publishReady,
  publication,
  request,
  setup,
  user,
} from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
afterEach(() => mediaNetwork.resetHandlers());
afterAll(() => mediaNetwork.disable());

async function fixture(sources: MediaSource[] = ["microphone"]) {
  const s = setup();
  let publisher = joined(
    await s.account.join(
      s.principal,
      grant(s.principal, s.scope),
      request(s.scope),
    ),
  );
  const listener = user();
  const receiving = joined(
    await env.ACCOUNT_MEDIA.getByName(listener.userId).join(
      listener,
      grant(listener, s.scope),
      request(s.scope),
    ),
  );
  let version = 0;
  const subscribe = async (publicationIds: string[]) => {
    const command = {
      handle: receiving.handle,
      operationId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedSessionVersion: version,
      publicationIds,
    };
    const result = await s.media.subscribe(
      listener,
      grant(listener, s.scope),
      command,
    );
    if (result.kind === "completed") version = result.sessionVersion;
    if (result.kind !== "negotiation") return result;
    const completed = await s.media.answer(listener, grant(listener, s.scope), {
      handle: receiving.handle,
      operationId: result.operationId,
      expectedSessionVersion: result.sessionVersion,
      sessionDescription: { type: "answer", sdp: "v=0\r\n" },
    });
    if (completed.kind === "completed") version = completed.sessionVersion;
    return completed;
  };
  const replace = async () => {
    publisher = joined(
      await s.account.transfer(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope, publisher.generation),
      ),
    );
    return publishReady(s, publisher.handle);
  };
  const first = await publishReady(s, publisher.handle, sources);
  expect(
    await subscribe(first.publications.map((pub) => pub.id)),
  ).toMatchObject({ kind: "completed" });
  const consumer = await runInDurableObject(s.media, (_instance, state) =>
    state.storage.sql
      .exec<{ session_key: string; provider_id: string }>(
        "SELECT session_key,provider_id FROM media_sessions WHERE participant_id=? AND direction='consumer'",
        receiving.handle.participantId,
      )
      .one(),
  );
  return {
    s,
    listener,
    receiving,
    subscribe,
    replace,
    consumer,
    publisher,
    first,
  };
}

describe("subscription handoff across disposable publisher generations", () => {
  it.each(["deafen", "remove"] as const)(
    "keeps repeated replacements usable despite close failure, then enforces %s on retained MIDs",
    async (action) => {
      const f = await fixture();
      f.s.fake.failClose = true;
      for (let generation = 2; generation <= 4; generation++) {
        const publication = await f.replace();
        const ids = publication.publications.map((pub) => pub.id);
        expect(await f.subscribe(ids)).toMatchObject({
          kind: "completed",
          subscriptions: [{ publication: { id: ids[0], generation } }],
        });
      }
      const consumerCalls = f.s.fake.calls.filter((call) =>
        call.path.includes(`/sessions/${f.consumer.provider_id}/`),
      );
      expect(
        consumerCalls.filter((call) => call.path.endsWith("/tracks/close")),
      ).toEqual([]);
      expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(
        4,
      );
      expect(
        await runInDurableObject(f.s.media, (_instance, state) => ({
          subscriptions: state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM media_subscriptions WHERE session_key=?",
              f.consumer.session_key,
            )
            .one().count,
          allocations: state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM media_allocations WHERE session_key=?",
              f.consumer.session_key,
            )
            .one().count,
        })),
      ).toEqual({ subscriptions: 1, allocations: 4 });
      f.s.fake.failClose = false;
      const snapshot = await f.s.media.snapshot(
        f.s.principal,
        grant(f.s.principal, f.s.scope),
        { room: f.s.scope },
      );
      if (snapshot.kind !== "media_snapshot")
        throw new Error("Expected snapshot");
      expect(
        await f.s.media.moderate(
          f.s.principal,
          grant(f.s.principal, f.s.scope),
          {
            room: f.s.scope,
            userId: f.listener.userId,
            action,
            enabled: true,
            commandId: crypto.randomUUID(),
            ...moderationTarget(snapshot.snapshot, f.listener.userId),
          },
        ),
      ).toMatchObject({ kind: "moderated", cleanupPending: false });
      expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(
        0,
      );
    },
  );

  it("retains forwarding cleanup after a failed deafen and room eviction", async () => {
    const f = await fixture();
    f.s.fake.failClose = true;
    const publication = await f.replace();
    expect(
      await f.subscribe(publication.publications.map((pub) => pub.id)),
    ).toMatchObject({ kind: "completed" });
    const snapshot = await f.s.media.snapshot(
      f.s.principal,
      grant(f.s.principal, f.s.scope),
      { room: f.s.scope },
    );
    if (snapshot.kind !== "media_snapshot")
      throw new Error("Expected snapshot");
    expect(
      await f.s.media.moderate(f.s.principal, grant(f.s.principal, f.s.scope), {
        room: f.s.scope,
        userId: f.listener.userId,
        action: "deafen",
        enabled: true,
        commandId: crypto.randomUUID(),
        ...moderationTarget(snapshot.snapshot, f.listener.userId),
      }),
    ).toMatchObject({ kind: "moderated", cleanupPending: true });
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(2);
    await evictDurableObject(f.s.media);
    f.s.fake.failClose = false;
    await runInDurableObject(f.s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET cleanup_at=1 WHERE cleanup_at IS NOT NULL",
      );
    });
    await runDurableObjectAlarm(f.s.media);
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(0);
  });

  it("rejects retained-resource exhaustion before reserving or calling the provider", async () => {
    const f = await fixture();
    const publication = await f.replace();
    await runInDurableObject(f.s.media, (_instance, state) => {
      for (let i = 1; i < MAX_CONSUMER_ALLOCATIONS; i++)
        state.storage.sql.exec(
          "INSERT INTO media_allocations(session_key,mid) VALUES(?,?)",
          f.consumer.session_key,
          `retained-${i}`,
        );
    });
    const before = f.s.fake.calls.length;
    expect(
      await f.subscribe(publication.publications.map((pub) => pub.id)),
    ).toEqual({ kind: "capacity" });
    expect(f.s.fake.calls).toHaveLength(before);
    expect(
      await runInDurableObject(f.s.media, (_instance, state) =>
        state.storage.sql
          .exec<{ phase: string; version: number }>(
            "SELECT phase,version FROM media_sessions WHERE session_key=?",
            f.consumer.session_key,
          )
          .one(),
      ),
    ).toEqual({ phase: "idle", version: 1 });
  });

  it("releases receiving allocations across repeated ordinary camera and screen stops", async () => {
    const sources: MediaSource[] = ["camera", "screen_video"];
    const f = await fixture(sources);
    let producerVersion = f.first.sessionVersion;
    for (let cycle = 0; cycle < 3; cycle++) {
      const stopped = await f.s.media.unpublish(
        f.s.principal,
        grant(f.s.principal, f.s.scope),
        {
          handle: f.publisher.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: producerVersion,
          sources,
        },
      );
      if (stopped.kind !== "completed") throw new Error(stopped.kind);
      await runInDurableObject(f.s.media, (_, state) => {
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS n FROM media_publications")
            .one(),
        ).toEqual({ n: 0 });
        expect(
          state.storage.sql
            .exec(
              "SELECT source_session_key,source_transferred FROM media_subscriptions",
            )
            .toArray(),
        ).toEqual(
          sources.map(() => ({
            source_session_key: sessionKey(
              f.publisher.handle.participantId,
              f.publisher.generation,
              "producer",
            ),
            source_transferred: 0,
          })),
        );
      });
      expect(await f.subscribe([])).toMatchObject({
        kind: "completed",
        subscriptions: [],
      });
      expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(
        0,
      );
      await runInDurableObject(f.s.media, (_, state) => {
        expect(
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS n FROM media_allocations WHERE session_key=?",
              f.consumer.session_key,
            )
            .one(),
        ).toEqual({ n: 0 });
      });
      if (cycle === 2) break;
      const next = await f.s.media.publish(
        f.s.principal,
        grant(f.s.principal, f.s.scope),
        publication(f.publisher.handle, sources, stopped.sessionVersion),
      );
      if (next.kind !== "negotiation") throw new Error(next.kind);
      expect(
        await f.s.media.ack(f.s.principal, grant(f.s.principal, f.s.scope), {
          handle: f.publisher.handle,
          operationId: next.operationId,
          expectedSessionVersion: next.sessionVersion,
        }),
      ).toMatchObject({ kind: "completed" });
      producerVersion = next.sessionVersion;
      expect(
        await f.subscribe(next.publications.map((pub) => pub.id)),
      ).toMatchObject({ kind: "completed" });
      expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(
        sources.length,
      );
    }
  });

  it("marks transfer mappings after unpublish and retains the exception through source pruning", async () => {
    const f = await fixture();
    expect(
      await f.s.media.unpublish(
        f.s.principal,
        grant(f.s.principal, f.s.scope),
        {
          handle: f.publisher.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: f.first.sessionVersion,
          sources: ["microphone"],
        },
      ),
    ).toMatchObject({ kind: "completed" });
    f.s.fake.failClose = true;
    const transferred = await runInDurableObject(
      f.s.media,
      async (instance, state) => {
        const rt = (instance as unknown as { runtime: RoomRuntime }).runtime;
        const observed = await observeSql(state.storage.sql, async () =>
          joined(
            await rt.env.ACCOUNT_MEDIA.getByName(f.s.principal.userId).transfer(
              f.s.principal,
              grant(f.s.principal, f.s.scope),
              request(f.s.scope, f.publisher.generation),
            ),
          ),
        );
        const lookup = observed.statements.find(
          (statement) =>
            /^update /i.test(statement.query) &&
            statement.query.includes('"source_session_key"'),
        )!;
        const plan = state.storage.sql
          .exec(
            `EXPLAIN QUERY PLAN ${lookup.query}`,
            ...(lookup.bindings as SqlStorageValue[]),
          )
          .toArray();
        expect(plan.map((row) => row.detail).join(" ")).toContain(
          "media_subscription_source",
        );
        return observed.value;
      },
    );
    const replacement = await publishReady(f.s, transferred.handle);
    const sourceKey = sessionKey(
      f.publisher.handle.participantId,
      f.publisher.generation,
      "producer",
    );
    await runInDurableObject(f.s.media, (instance, state) => {
      const rt = (instance as unknown as { runtime: RoomRuntime }).runtime;
      pruneMediaRecords(rt, Date.now());
      expect(
        state.storage.sql
          .exec("SELECT * FROM media_sessions WHERE session_key=?", sourceKey)
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec(
            "SELECT source_session_key,source_transferred FROM media_subscriptions WHERE session_key=?",
            f.consumer.session_key,
          )
          .toArray(),
      ).toEqual([{ source_session_key: sourceKey, source_transferred: 1 }]);
    });
    expect(
      await f.subscribe(replacement.publications.map((pub) => pub.id)),
    ).toMatchObject({ kind: "completed" });
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(2);
    expect(
      f.s.fake.calls.filter((call) =>
        call.path.endsWith(`/sessions/${f.consumer.provider_id}/tracks/close`),
      ),
    ).toEqual([]);
  });

  it("retains ordinary receiving resources after failed closure and releases them through existing cleanup", async () => {
    const f = await fixture();
    await f.s.media.unpublish(f.s.principal, grant(f.s.principal, f.s.scope), {
      handle: f.publisher.handle,
      operationId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedSessionVersion: f.first.sessionVersion,
      sources: ["microphone"],
    });
    f.s.fake.failClose = true;
    expect(await f.subscribe([])).toMatchObject({ kind: "provider_error" });
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(1);
    await evictDurableObject(f.s.media);
    await runInDurableObject(f.s.media, (_, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS n FROM media_allocations WHERE session_key=?",
            f.consumer.session_key,
          )
          .one(),
      ).toEqual({ n: 1 });
      state.storage.sql.exec(
        "UPDATE media_participants SET cleanup_at=1 WHERE id=?",
        f.receiving.handle.participantId,
      );
    });
    f.s.fake.failClose = false;
    await runDurableObjectAlarm(f.s.media);
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(0);
  });

  it("rejects a delayed allocation after the source transfers without installing a stale mapping", async () => {
    const f = await fixture();
    const second = await f.replace();
    const source = second.publications[0]!;
    const gate = barrier();
    f.s.fake.subscribeGate = gate.promise;
    const before = f.s.fake.calls.length;
    const subscribing = f.subscribe(second.publications.map((pub) => pub.id));
    try {
      await expect
        .poll(() =>
          f.s.fake.calls
            .slice(before)
            .some((call) =>
              call.path.endsWith(
                `/sessions/${f.consumer.provider_id}/tracks/new`,
              ),
            ),
        )
        .toBe(true);
      await f.replace();
    } finally {
      gate.release();
    }
    expect(await subscribing).toMatchObject({ kind: "recovery_required" });
    await runInDurableObject(f.s.media, (_, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT * FROM media_subscriptions WHERE source_session_key=?",
            sessionKey(source.participantId, source.generation, "producer"),
          )
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS n FROM media_allocations WHERE session_key=?",
            f.consumer.session_key,
          )
          .one(),
      ).toEqual({ n: 0 });
    });
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(0);
  });

  it("still closes a hidden source belonging to a current publisher", async () => {
    const f = await fixture();
    expect(await f.subscribe([])).toMatchObject({
      kind: "completed",
      subscriptions: [],
    });
    expect(f.s.fake.sessions.get(f.consumer.provider_id)!.tracks.size).toBe(0);
    expect(
      f.s.fake.calls.some((call) =>
        call.path.endsWith(`/sessions/${f.consumer.provider_id}/tracks/close`),
      ),
    ).toBe(true);
  });
});
