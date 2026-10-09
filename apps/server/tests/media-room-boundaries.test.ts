import { moderationTarget } from "@tests/helpers/media-room";
import { barrier } from "@tests/helpers/barrier";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModerateMediaRequest } from "@vaskel/contracts/media";
import { authorizeParticipant } from "@/server/actors/media/authorization";
import { moderate } from "@/server/actors/media/moderation";
import { reserve } from "@/server/actors/media/operations";
import {
  publicationError,
  subscriptionError,
} from "@/server/actors/media/permissions";
import {
  openMediaDatabase,
  type RoomRuntime,
} from "@/server/actors/media/store";
import { RealtimeClient } from "@/server/providers/realtime";
import { mediaNetwork } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  publication,
  publishReady,
  request,
  setup,
  user,
} from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
afterEach(() => mediaNetwork.resetHandlers());
afterAll(() => mediaNetwork.disable());

async function join(s: ReturnType<typeof setup>) {
  return joined(
    await s.account.join(
      s.principal,
      grant(s.principal, s.scope),
      request(s.scope),
    ),
  );
}

async function receiver(s: ReturnType<typeof setup>) {
  const principal = user();
  const accepted = joined(
    await env.ACCOUNT_MEDIA.getByName(principal.userId).join(
      principal,
      grant(principal, s.scope),
      request(s.scope),
    ),
  );
  return { principal, accepted };
}

async function moderation(
  s: ReturnType<typeof setup>,
  userId: string,
  action: ModerateMediaRequest["action"],
): Promise<ModerateMediaRequest> {
  const snapshot = await s.media.snapshot(
    s.principal,
    grant(s.principal, s.scope),
    { room: s.scope },
  );
  if (snapshot.kind !== "media_snapshot")
    throw new Error("Expected room snapshot.");
  return {
    room: s.scope,
    userId,
    action,
    enabled: true,
    commandId: crypto.randomUUID(),
    ...moderationTarget(snapshot.snapshot, userId),
  };
}

async function restricted(
  s: ReturnType<typeof setup>,
  userId: string,
  field: "muted" | "screen_revoked" | "deafened",
) {
  await expect
    .poll(() =>
      runInDurableObject(
        s.media,
        (_instance, state) =>
          state.storage.sql
            .exec<{ value: number }>(
              `SELECT ${field} AS value FROM media_participants WHERE user_id=?`,
              userId,
            )
            .one().value,
      ),
    )
    .toBe(1);
}

describe("room transaction and provider failure boundaries", () => {
  it.each([
    ["mute", "microphone"],
    ["screen_revoke", "screen_video"],
    ["deafen", null],
  ] as const)(
    "reloads %s committed after authorization before reserving",
    async (action, source) => {
      const s = setup(),
        accepted = await join(s);
      await runInDurableObject(s.media, async (_instance, state) => {
        const rt: RoomRuntime = {
          ctx: state,
          env,
          db: openMediaDatabase(state.storage),
          provider: new RealtimeClient(env),
          inflight: new Map(),
        };
        const authorization = grant(s.principal, s.scope);
        const authorized = await authorizeParticipant(
          rt,
          s.principal,
          authorization,
          accepted.handle,
        );
        if (authorized.kind !== "participant")
          throw new Error("Expected participant.");
        expect(authorized.participant.muted).toBe(0);
        expect(
          await moderate(rt, s.principal, authorization, {
            room: s.scope,
            userId: s.principal.userId,
            action,
            enabled: true,
            commandId: crypto.randomUUID(),
            participantGeneration: authorized.participant.generation,
            expectedControlVersion: authorized.participant.control_version,
          }),
        ).toMatchObject({ kind: "moderated" });
        const command = source
          ? publication(accepted.handle, [source])
          : {
              handle: accepted.handle,
              operationId: crypto.randomUUID(),
              issuedAt: Date.now(),
              expectedSessionVersion: 0,
              publicationIds: [],
            };
        expect(
          await reserve(
            rt,
            s.principal,
            authorization,
            authorized.participant,
            source ? "producer" : "consumer",
            command,
            (current) =>
              source
                ? publicationError(current, authorization, [source])
                : subscriptionError(current),
          ),
        ).toEqual({
          kind: "action_restricted",
          restriction: action === "screen_revoke" ? "screen" : action,
        });
        expect(
          state.storage.sql.exec("SELECT * FROM media_operations").toArray(),
        ).toEqual([]);
        expect(
          state.storage.sql
            .exec("SELECT version,phase FROM media_sessions")
            .toArray(),
        ).toEqual([
          { version: 0, phase: "idle" },
          { version: 0, phase: "idle" },
        ]);
      });
      expect(
        s.fake.calls.filter((call) => call.path.endsWith("/tracks/new")),
      ).toHaveLength(0);
    },
  );

  it.each([
    ["mute", "muted", "microphone"],
    ["screen_revoke", "screen_revoked", "screen_video"],
  ] as const)(
    "rejects a delayed publication after %s and closes its allocation",
    async (action, field, source) => {
      const s = setup(),
        accepted = await join(s),
        gate = barrier();
      s.fake.publishGate = gate.promise;
      const publishing = s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle, [source]),
      );
      let moderating;
      try {
        await expect
          .poll(
            () =>
              s.fake.calls.filter((call) => call.path.endsWith("/tracks/new"))
                .length,
          )
          .toBe(1);
        moderating = s.media.moderate(
          s.principal,
          grant(s.principal, s.scope),
          await moderation(s, s.principal.userId, action),
        );
        await restricted(s, s.principal.userId, field);
      } finally {
        gate.release();
      }
      expect(await publishing).toMatchObject({
        kind: "recovery_required",
        reason: "transport_closed",
      });
      expect(await moderating).toMatchObject({ kind: "moderated" });
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
            .exec("SELECT * FROM media_publications WHERE ready=1")
            .toArray(),
        ).toEqual([]);
        expect(
          state.storage.sql
            .exec("SELECT phase FROM media_sessions WHERE direction='producer'")
            .one(),
        ).toEqual({ phase: "closed" });
      });
    },
  );

  it.each([true, false])(
    "rejects deafen during delayed subscription, renegotiation=%s",
    async (renegotiation) => {
      const s = setup(),
        accepted = await join(s);
      const published = await publishReady(s, accepted.handle);
      const receiving = await receiver(s),
        gate = barrier();
      s.fake.remoteRequiresRenegotiation = renegotiation;
      s.fake.subscribeGate = gate.promise;
      const subscribing = s.media.subscribe(
        receiving.principal,
        grant(receiving.principal, s.scope),
        {
          handle: receiving.accepted.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: 0,
          publicationIds: published.publications.map((pub) => pub.id),
        },
      );
      let moderating;
      try {
        await expect
          .poll(
            () =>
              s.fake.calls.filter((call) => call.path.endsWith("/tracks/new"))
                .length,
          )
          .toBe(2);
        moderating = s.media.moderate(
          s.principal,
          grant(s.principal, s.scope),
          await moderation(s, receiving.principal.userId, "deafen"),
        );
        await restricted(s, receiving.principal.userId, "deafened");
      } finally {
        gate.release();
      }
      expect(await subscribing).toMatchObject({
        kind: "recovery_required",
        reason: "transport_closed",
      });
      expect(await moderating).toMatchObject({ kind: "moderated" });
      expect(
        [...s.fake.sessions.values()]
          .flatMap((session) => [...session.tracks.values()])
          .every((track) => track.location === "local"),
      ).toBe(true);
      await runInDurableObject(s.media, (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM media_subscriptions").toArray(),
        ).toEqual([]);
      });
    },
  );

  it("rejects deafen while the consumer answer awaits the provider", async () => {
    const s = setup(),
      accepted = await join(s),
      published = await publishReady(s, accepted.handle),
      receiving = await receiver(s);
    const subscribed = await s.media.subscribe(
      receiving.principal,
      grant(receiving.principal, s.scope),
      {
        handle: receiving.accepted.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        publicationIds: published.publications.map((pub) => pub.id),
      },
    );
    if (subscribed.kind !== "negotiation") throw new Error("Expected offer.");
    const gate = barrier();
    s.fake.renegotiateGate = gate.promise;
    const answering = s.media.answer(
      receiving.principal,
      grant(receiving.principal, s.scope),
      {
        handle: receiving.accepted.handle,
        operationId: subscribed.operationId,
        expectedSessionVersion: subscribed.sessionVersion,
        sessionDescription: { type: "answer", sdp: "v=0\r\n" },
      },
    );
    let moderating;
    try {
      await expect
        .poll(
          () =>
            s.fake.calls.filter((call) => call.path.endsWith("/renegotiate"))
              .length,
        )
        .toBe(1);
      moderating = s.media.moderate(
        s.principal,
        grant(s.principal, s.scope),
        await moderation(s, receiving.principal.userId, "deafen"),
      );
      await restricted(s, receiving.principal.userId, "deafened");
    } finally {
      gate.release();
    }
    expect(await answering).toMatchObject({
      kind: "recovery_required",
      reason: "transport_closed",
    });
    expect(await moderating).toMatchObject({ kind: "moderated" });
    expect(
      [...s.fake.sessions.values()]
        .flatMap((session) => [...session.tracks.values()])
        .every((track) => track.location === "local"),
    ).toBe(true);
  });

  it("returns and replays the complete MID map without an offer, including an empty replacement", async () => {
    const s = setup(),
      accepted = await join(s),
      published = await publishReady(s, accepted.handle),
      receiving = await receiver(s);
    s.fake.remoteRequiresRenegotiation = false;
    const command = {
      handle: receiving.accepted.handle,
      operationId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedSessionVersion: 0,
      publicationIds: published.publications.map((pub) => pub.id),
    };
    const first = await s.media.subscribe(
      receiving.principal,
      grant(receiving.principal, s.scope),
      command,
    );
    expect(first).toMatchObject({
      kind: "completed",
      subscriptions: [
        { publication: published.publications[0], mid: expect.any(String) },
      ],
    });
    await evictDurableObject(s.media);
    expect(
      await s.media.subscribe(
        receiving.principal,
        grant(receiving.principal, s.scope),
        {
          publicationIds: command.publicationIds,
          expectedSessionVersion: command.expectedSessionVersion,
          issuedAt: command.issuedAt,
          operationId: command.operationId,
          handle: command.handle,
        },
      ),
    ).toEqual(first);
    expect(
      await s.media.subscribe(
        receiving.principal,
        grant(receiving.principal, s.scope),
        {
          ...command,
          operationId: crypto.randomUUID(),
          expectedSessionVersion: 1,
        },
      ),
    ).toMatchObject({
      kind: "completed",
      subscriptions:
        first.kind === "completed" ? first.subscriptions : undefined,
    });
    expect(
      await s.media.subscribe(
        receiving.principal,
        grant(receiving.principal, s.scope),
        {
          ...command,
          operationId: crypto.randomUUID(),
          expectedSessionVersion: 2,
          publicationIds: [],
        },
      ),
    ).toMatchObject({ kind: "completed", subscriptions: [] });
  });

  it("requires transport recovery when the publisher disappears during allocation", async () => {
    const s = setup(),
      accepted = await join(s),
      published = await publishReady(s, accepted.handle),
      receiving = await receiver(s),
      gate = barrier();
    s.fake.subscribeGate = gate.promise;
    const subscribing = s.media.subscribe(
      receiving.principal,
      grant(receiving.principal, s.scope),
      {
        handle: receiving.accepted.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        publicationIds: published.publications.map((pub) => pub.id),
      },
    );
    try {
      await expect
        .poll(
          () =>
            s.fake.calls.filter((call) => call.path.endsWith("/tracks/new"))
              .length,
        )
        .toBe(2);
      expect(
        await s.media.unpublish(s.principal, grant(s.principal, s.scope), {
          handle: accepted.handle,
          operationId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedSessionVersion: 1,
          sources: ["microphone"],
        }),
      ).toMatchObject({ kind: "completed" });
    } finally {
      gate.release();
    }
    expect(await subscribing).toMatchObject({
      kind: "recovery_required",
      reason: "transport_closed",
    });
    expect(
      [...s.fake.sessions.values()].every(
        (session) => session.tracks.size === 0,
      ),
    ).toBe(true);
  });

  it("propagates an unexpected local SQL failure and preserves cleanup across eviction", async () => {
    const s = setup(),
      accepted = await join(s);
    s.fake.failClose = true;
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fixture_local_failure BEFORE UPDATE OF phase ON media_sessions WHEN NEW.phase='awaiting_apply' BEGIN SELECT RAISE(ABORT, 'fixture_local_failure'); END",
      );
    });
    await runInDurableObject(s.media, async (instance) => {
      await expect(
        instance.publish(
          s.principal,
          grant(s.principal, s.scope),
          publication(accepted.handle),
        ),
      ).rejects.toThrow("fixture_local_failure");
    });
    await runInDurableObject(s.media, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT status FROM media_participants").one(),
      ).toEqual({ status: "closing" });
      expect(
        state.storage.sql.exec("SELECT * FROM media_allocations").toArray(),
      ).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    s.fake.failClose = false;
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_participants SET cleanup_at=1 WHERE cleanup_at IS NOT NULL",
      );
    });
    await evictDurableObject(s.media);
    expect(await runDurableObjectAlarm(s.media)).toBe(true);
    expect(
      [...s.fake.sessions.values()].every(
        (session) => session.tracks.size === 0,
      ),
    ).toBe(true);
  });
});
