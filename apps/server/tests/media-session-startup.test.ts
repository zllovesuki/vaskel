import { moderationTarget } from "@tests/helpers/media-room";
import { barrier } from "@tests/helpers/barrier";
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
import {
  mediaTransaction,
  recordClosure,
} from "@/server/actors/media/diagnostics";
import { markParticipantClosing } from "@/server/actors/media/cleanup";
import { reserve } from "@/server/actors/media/operations";
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
afterEach(() => {
  mediaNetwork.resetHandlers();
  vi.restoreAllMocks();
});
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
function creates(s: ReturnType<typeof setup>) {
  return s.fake.calls.filter((call) => call.path.endsWith("/sessions/new"))
    .length;
}
async function listener(s: ReturnType<typeof setup>) {
  const principal = user();
  const account = env.ACCOUNT_MEDIA.getByName(principal.userId);
  const accepted = joined(
    await account.join(principal, grant(principal, s.scope), request(s.scope)),
  );
  return { ...s, principal, account, accepted };
}
async function finishSubscription(
  s: ReturnType<typeof setup>,
  accepted: ReturnType<typeof joined>,
  publicationIds: string[],
  expectedSessionVersion = 0,
) {
  const command = {
    handle: accepted.handle,
    publicationIds,
    operationId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedSessionVersion,
  };
  const result = await s.media.subscribe(
    s.principal,
    grant(s.principal, s.scope),
    command,
  );
  if (result.kind !== "negotiation")
    throw new Error(`Expected subscription offer, got ${result.kind}`);
  const answer = {
    handle: accepted.handle,
    operationId: result.operationId,
    expectedSessionVersion: result.sessionVersion,
    sessionDescription: { type: "answer" as const, sdp: "v=0\r\n" },
  };
  expect(
    await s.media.answer(s.principal, grant(s.principal, s.scope), answer),
  ).toMatchObject({
    kind: "completed",
    subscriptions: [{ publication: { id: publicationIds[0] } }],
  });
  return command;
}

describe("lazy media provider session startup", () => {
  it("keeps idle consumers unallocated beyond provider setup expiry, then receives in both directions without replacement", async () => {
    const s = setup();
    // This is a deliberately short fake lifetime, not a claim about SFU timing.
    s.fake.unusedSessionTtlMs = 5_000;
    const a = await join(s);
    expect(creates(s)).toBe(0);
    const first = await publishReady(s, a.handle);
    expect(creates(s)).toBe(1);
    const empty = {
      handle: a.handle,
      operationId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedSessionVersion: 0,
      publicationIds: [],
    };
    expect(
      await s.media.subscribe(s.principal, grant(s.principal, s.scope), empty),
    ).toMatchObject({ kind: "completed", subscriptions: [] });
    for (let index = 0; index < 3; index++) {
      for (const session of s.fake.sessions.values())
        session.createdAt -= 10_000;
      expect(
        await s.media.heartbeat(s.principal, grant(s.principal, s.scope), {
          handle: a.handle,
        }),
      ).toMatchObject({ kind: "heartbeat" });
    }
    expect(creates(s)).toBe(1);
    await runInDurableObject(s.media, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT provider_id,phase,deadline FROM media_sessions WHERE direction='consumer'",
          )
          .one(),
      ).toEqual({ provider_id: null, phase: "idle", deadline: 0 });
    });
    const b = await listener(s);
    const second = await publishReady(b, b.accepted.handle);
    await finishSubscription(
      s,
      a,
      second.publications.map((pub) => pub.id),
      1,
    );
    await finishSubscription(
      b,
      b.accepted,
      first.publications.map((pub) => pub.id),
    );
    expect(creates(s)).toBe(4);
    expect(await s.account.status(s.principal)).toMatchObject({
      generation: a.generation,
      admission: { kind: "transfer_required" },
    });
  });

  it.each(["producer", "consumer"] as const)(
    "serializes concurrent first %s use and replays the retained result through eviction",
    async (direction) => {
      const s = setup(),
        a = await join(s);
      const other = direction === "consumer" ? await listener(s) : null;
      const published = other
        ? await publishReady(other, other.accepted.handle)
        : null;
      const baseline = creates(s);
      const gate = barrier();
      s.fake.createGate = gate.promise;
      const command =
        direction === "producer"
          ? publication(a.handle)
          : {
              handle: a.handle,
              publicationIds: published!.publications.map((pub) => pub.id),
              operationId: crypto.randomUUID(),
              issuedAt: Date.now(),
              expectedSessionVersion: 0,
            };
      const invoke = () =>
        "tracks" in command
          ? s.media.publish(s.principal, grant(s.principal, s.scope), command)
          : s.media.subscribe(
              s.principal,
              grant(s.principal, s.scope),
              command,
            );
      const pending = invoke();
      try {
        await expect.poll(() => creates(s)).toBe(baseline + 1);
        expect(await invoke()).toMatchObject({
          kind: "session_busy",
          operationId: command.operationId,
        });
        expect(creates(s)).toBe(baseline + 1);
      } finally {
        gate.release();
      }
      const result = await pending;
      expect(result.kind).toBe("negotiation");
      await evictDurableObject(s.media);
      expect(await invoke()).toEqual(result);
      expect(creates(s)).toBe(baseline + 1);
    },
  );

  it("does not recreate a provider session after an uncertain creation result or an evicted reservation", async () => {
    const s = setup(),
      a = await join(s);
    s.fake.loseCreateResponse = true;
    const command = publication(a.handle);
    expect(
      await s.media.publish(s.principal, grant(s.principal, s.scope), command),
    ).toMatchObject({ kind: "provider_error", uncertain: true });
    expect(creates(s)).toBe(1);
    expect(s.fake.sessions.size).toBe(1);
    await evictDurableObject(s.media);
    expect(
      await s.media.publish(s.principal, grant(s.principal, s.scope), command),
    ).toMatchObject({ kind: "recovery_required" });
    expect(creates(s)).toBe(1);
    const b = await listener(s);
    const next = publication(b.accepted.handle);
    await runInDurableObject(s.media, async (_instance, state) => {
      const rt: RoomRuntime = {
        ctx: state,
        env,
        db: openMediaDatabase(state.storage),
        provider: new RealtimeClient(env),
        inflight: new Map(),
      };
      const participant = await rt.db
        .selectFrom("media_participants")
        .selectAll()
        .where("id", "=", b.principal.userId)
        .executeTakeFirstOrThrow();
      expect(
        await reserve(
          rt,
          b.principal,
          grant(b.principal, s.scope),
          participant,
          "producer",
          next,
        ),
      ).toMatchObject({ kind: "reserved" });
    });
    await evictDurableObject(s.media);
    expect(
      await s.media.publish(b.principal, grant(b.principal, s.scope), next),
    ).toMatchObject({ kind: "session_busy" });
    expect(creates(s)).toBe(1);
    await runInDurableObject(s.media, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_sessions SET deadline=1 WHERE phase='requesting'",
      );
    });
    await runDurableObjectAlarm(s.media);
    expect(
      await s.media.publish(b.principal, grant(b.principal, s.scope), next),
    ).toMatchObject({ kind: "recovery_required" });
    expect(creates(s)).toBe(1);
  });

  it.each([
    "leave",
    "transfer",
    "remove",
    "mute",
    "permission",
    "deafen",
  ] as const)(
    "retains late creation while %s fences its first exchange",
    async (action) => {
      const s = setup(),
        a = await join(s);
      const remote = action === "deafen" ? await listener(s) : null;
      const published = remote
        ? await publishReady(remote, remote.accepted.handle)
        : null;
      const gate = barrier(),
        baseline = creates(s);
      s.fake.createGate = gate.promise;
      const pending =
        action === "deafen"
          ? s.media.subscribe(s.principal, grant(s.principal, s.scope), {
              handle: a.handle,
              operationId: crypto.randomUUID(),
              issuedAt: Date.now(),
              expectedSessionVersion: 0,
              publicationIds: published!.publications.map((pub) => pub.id),
            })
          : s.media.publish(
              s.principal,
              grant(s.principal, s.scope),
              publication(a.handle),
            );
      let changing: Promise<unknown> | undefined;
      try {
        await expect.poll(() => creates(s)).toBe(baseline + 1);
        if (action === "leave")
          changing = s.account.leave(s.principal, {
            handle: a.handle,
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          });
        else if (action === "transfer")
          changing = s.account.transfer(
            s.principal,
            grant(s.principal, s.scope),
            request(s.scope, a.generation),
          );
        else if (action === "permission")
          changing = s.media.invalidate({
            room: s.scope,
            userIds: [s.principal.userId],
            permissionGeneration: 2,
          });
        else {
          const snapshot = await s.media.snapshot(
            s.principal,
            grant(s.principal, s.scope),
            { room: s.scope },
          );
          if (snapshot.kind !== "media_snapshot")
            throw new Error("Expected snapshot");
          changing = s.media.moderate(
            s.principal,
            grant(s.principal, s.scope),
            {
              room: s.scope,
              userId: s.principal.userId,
              action,
              enabled: true,
              commandId: crypto.randomUUID(),
              ...moderationTarget(snapshot.snapshot, s.principal.userId),
            },
          );
        }
        await expect
          .poll(() =>
            runInDurableObject(
              s.media,
              (_instance, state) =>
                state.storage.sql
                  .exec<{ status: string }>(
                    "SELECT status FROM media_participants WHERE id=? AND generation=?",
                    s.principal.userId,
                    a.generation,
                  )
                  .one().status,
            ),
          )
          .not.toBe("active");
      } finally {
        gate.release();
      }
      expect((await pending).kind).not.toBe("negotiation");
      await changing;
      expect(creates(s)).toBe(baseline + 1);
      expect(
        s.fake.calls.filter((call) => call.path.endsWith("/tracks/new")),
      ).toHaveLength(baseline);
      await expect
        .poll(() =>
          s.fake.calls.some(
            (call) =>
              call.method === "GET" &&
              call.path.endsWith(`/fixture-session-${baseline + 1}`),
          ),
        )
        .toBe(true);
    },
  );

  it("logs a negotiation failure before its cleanup provider wait settles", async () => {
    const s = setup(),
      a = await join(s);
    s.fake.partialPublish = true;
    const gate = barrier(),
      fetcher = s.fake.fetcher;
    let cleaning = false;
    s.fake.fetcher = async (input, init) => {
      const outgoing = new Request(
        input instanceof Request ? input.clone() : input,
        init,
      );
      if (outgoing.method === "GET") {
        cleaning = true;
        await gate.promise;
      }
      return fetcher(input, init);
    };
    const sink = vi.spyOn(console, "warn").mockImplementation(() => {});
    const command = publication(a.handle, ["microphone", "camera"]);
    const pending = s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      command,
    );
    try {
      await expect.poll(() => cleaning).toBe(true);
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "media_operation_failed",
          operation: "publish",
          participantId: a.handle.participantId,
          generation: a.generation,
          operationId: command.operationId,
          direction: "producer",
          version: 1,
        }),
      );
    } finally {
      gate.release();
    }
    expect(await pending).toMatchObject({ kind: "provider_error" });
  });

  it("closes an unallocated participant without provider work and emits only committed closure changes", async () => {
    const s = setup(),
      a = await join(s);
    expect(
      await s.media.publish(
        s.principal,
        { ...grant(s.principal, s.scope), canSpeak: false },
        publication(a.handle),
      ),
    ).toMatchObject({ kind: "action_restricted" });
    expect(
      await s.media.unpublish(s.principal, grant(s.principal, s.scope), {
        handle: a.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        sources: ["microphone"],
      }),
    ).toMatchObject({ kind: "completed" });
    expect(s.fake.calls).toEqual([]);
    await runInDurableObject(s.media, async (_instance, state) => {
      const rt: RoomRuntime = {
        ctx: state,
        env,
        db: openMediaDatabase(state.storage),
        provider: new RealtimeClient(env),
        inflight: new Map(),
      };
      const sink = vi.spyOn(console, "log").mockImplementation(() => {});
      const p = { id: a.handle.participantId, generation: a.generation };
      await expect(
        mediaTransaction(rt, async (transaction) => {
          await markParticipantClosing(transaction, p, "negotiation_failed");
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(sink).not.toHaveBeenCalled();
      await mediaTransaction(rt, (transaction) =>
        markParticipantClosing(transaction, p, "negotiation_failed"),
      );
      await mediaTransaction(rt, (transaction) =>
        markParticipantClosing(transaction, p, "negotiation_failed"),
      );
      await mediaTransaction(rt, (transaction) =>
        markParticipantClosing(transaction, p, "removed"),
      );
      expect(sink.mock.calls).toEqual([
        [
          expect.objectContaining({
            event: "media_participant_closed",
            closureReason: "negotiation_failed",
            terminalUpgrade: false,
          }),
        ],
        [
          expect.objectContaining({
            event: "media_participant_closed",
            closureReason: "removed",
            terminalUpgrade: true,
          }),
        ],
      ]);
      sink.mockClear();
      // Model the native callback being retried before its eventual commit.
      const transactionDriver = vi
        .spyOn(state.storage, "transaction")
        .mockImplementation(async (callback) => {
          await callback({
            ...state.storage,
            rollback() {
              throw new Error("Unexpected rollback in callback replay fixture");
            },
          } as DurableObjectTransaction);
          return callback({
            ...state.storage,
            rollback() {
              throw new Error("Unexpected rollback in callback replay fixture");
            },
          } as DurableObjectTransaction);
        });
      const previous = await rt.db
        .selectFrom("media_participants")
        .selectAll()
        .where("id", "=", p.id)
        .executeTakeFirstOrThrow();
      await mediaTransaction(rt, async (transaction) => {
        recordClosure(
          transaction,
          { ...previous, reason: null },
          "negotiation_failed",
        );
      });
      expect(sink).toHaveBeenCalledTimes(1);
      transactionDriver.mockRestore();
      sink.mockImplementation(() => {
        throw new Error("sink failed");
      });
      await expect(
        mediaTransaction(rt, async (transaction) => {
          recordClosure(transaction, { ...previous, reason: null }, "removed");
          return true;
        }),
      ).resolves.toBe(true);
      sink.mockRestore();
    });
    await s.media.endClaim({
      room: s.scope,
      participantId: a.handle.participantId,
      generation: a.generation,
      reason: "leave",
    });
    expect(s.fake.calls).toEqual([]);
  });
});
