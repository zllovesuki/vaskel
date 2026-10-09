import type {
  NotificationEligibleMessage,
  NotificationMessageReference,
} from "@/server/notifications/protocol";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  NotificationOutcomeSchema,
  NOTIFICATION_GROUP_WAIT_MS,
  NOTIFICATION_ROOM_SPACING_MS,
  NOTIFICATION_WORK_LIFETIME_MS,
  type NotificationCommand,
  type NotificationState,
  type PushSubscription,
} from "@vaskel/contracts/notifications";
import { base64url } from "@/server/auth/crypto";
import {
  notificationDatabase,
  roomKey,
} from "@/server/actors/notification/store";
import { consumeDue } from "@/server/actors/notification/scheduling";
import { dispatchGroup } from "@/server/actors/notification/dispatch";
import {
  ReadyPushRequestSchema,
  type ReadyPushRequest,
} from "@/server/notifications/transport";
import type { Principal } from "@/server/domain/principal";
import type { NotificationDO } from "@/server/actors/notification/notification-do";
import { MessageDO } from "@/server/actors/shared/message-do";
import { observeSql } from "@tests/helpers/sql-observer";
import { decryptPush, pushReceiver } from "@tests/helpers/push-provider";
import { decodePushBytes } from "@/server/notifications/endpoint";
import { barrier } from "@tests/helpers/barrier";

function commandBase(expectedRevision: number) {
  return {
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedRevision,
  };
}
async function subscription(): Promise<PushSubscription> {
  const keys = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: base64url(
        new Uint8Array(
          (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
        ),
      ),
      auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}
function stateOf(input: unknown): NotificationState {
  const parsed = NotificationOutcomeSchema.parse(input);
  if (
    parsed.kind !== "notification_state" &&
    parsed.kind !== "notification_updated"
  )
    throw new Error(parsed.kind);
  return parsed.state;
}
async function setup() {
  const principal: Principal = {
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    expiresAt: Date.now() + 60_000,
  };
  const actor = env.NOTIFICATION_DO.getByName(principal.userId);
  const state = stateOf(await actor.status(principal));
  const enable: NotificationCommand = {
    ...commandBase(state.revision),
    kind: "enable",
    language: "ja",
    deviceId: crypto.randomUUID(),
    label: "Laptop",
    subscription: await subscription(),
  };
  const enrolled = stateOf(await actor.command(principal, enable));
  return { principal, actor, enable, state: enrolled };
}
function reference(): NotificationMessageReference {
  return {
    owner: { kind: "server", id: crypto.randomUUID() },
    ownerGeneration: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    sequence: 1,
    createdAt: Date.now(),
    senderLabel: "Friend",
  };
}
async function expectOfferSkipped(
  stub: DurableObjectStub<NotificationDO>,
  offered = reference(),
) {
  await runInDurableObject(stub, async (actor, ctx) => {
    const transaction = vi.spyOn(ctx.storage, "transaction");
    try {
      const observed = await observeSql(ctx.storage.sql, () =>
        actor.offerCommittedMessage(offered),
      );
      expect(observed.statements).toHaveLength(0);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });
}
async function expectOfferPending(stub: DurableObjectStub<NotificationDO>) {
  const offered = reference();
  await stub.offerCommittedMessage(offered);
  await runInDurableObject(stub, async (_, ctx) => {
    const pending = await notificationDatabase(ctx.storage)
      .selectFrom("notification_pending")
      .select("references_json")
      .where("room_key", "=", roomKey(offered))
      .executeTakeFirstOrThrow();
    expect(JSON.parse(pending.references_json)).toEqual([offered]);
  });
}
function eligible(
  reference: NotificationMessageReference,
): NotificationEligibleMessage {
  return {
    reference,
    trigger: "direct",
    senderLabel: reference.senderLabel,
    roomLabel: "Friends",
    text: "Hello",
  };
}
function mockDispatch(
  resolve: MessageDO["selectNotificationMessage"],
  jobs: ReadyPushRequest[],
) {
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  vi.spyOn(env.IDENTITY_DB, "prepare").mockImplementation(() => {
    throw new Error("Identity database must not be read");
  });
  vi.spyOn(env.PUSH_QUEUE, "sendBatch").mockImplementation(async (batch) => {
    jobs.push(
      ...Array.from(batch, (job) => ReadyPushRequestSchema.parse(job.body)),
    );
    return {
      metadata: { metrics: { backlogCount: jobs.length, backlogBytes: 0 } },
    };
  });
  // RPC methods live on the prototype; instance properties are not exposed by workerd.
  vi.spyOn(MessageDO.prototype, "selectNotificationMessage").mockImplementation(
    resolve,
  );
  return env;
}

describe("account notification actor native state", () => {
  it("skips unenrolled offers without SQL or transaction entry, including after eviction", async () => {
    const accountId = crypto.randomUUID();
    const actor = env.NOTIFICATION_DO.getByName(accountId);
    await expectOfferSkipped(actor);
    await evictDurableObject(actor);
    await expectOfferSkipped(actor);
  });
  it("rejects paused accounts from memory and reloads current preferences after eviction and command recovery", async () => {
    const s = await setup();
    const pause: NotificationCommand = {
      ...commandBase(1),
      kind: "preferences",
      paused: true,
      preview: "generic",
      language: "en",
    };
    stateOf(await s.actor.command(s.principal, pause));
    await expectOfferSkipped(s.actor);
    await evictDurableObject(s.actor);
    await expectOfferSkipped(s.actor);
    stateOf(
      await s.actor.command(s.principal, {
        ...pause,
        ...commandBase(2),
        paused: false,
      }),
    );
    await expectOfferPending(s.actor);
    stateOf(await s.actor.command(s.principal, pause));
    await expectOfferPending(s.actor);
  });
  it("rejects expired and future references before transaction entry", async () => {
    const s = await setup();
    for (const createdAt of [
      Date.now() - NOTIFICATION_WORK_LIFETIME_MS,
      Date.now() + 60_000,
    ])
      await expectOfferSkipped(s.actor, {
        ...reference(),
        createdAt,
      });
  });
  it("rolls back a new group if its durable wake cannot be scheduled", async () => {
    const s = await setup();
    await runInDurableObject(s.actor, async (actor, ctx) => {
      const database = notificationDatabase(ctx.storage);
      const ref = reference();
      const alarm = vi
        .spyOn(ctx.storage, "setAlarm")
        .mockRejectedValueOnce(new Error("alarm unavailable"));
      try {
        await expect(actor.offerCommittedMessage(ref)).rejects.toThrow(
          "alarm unavailable",
        );
      } finally {
        alarm.mockRestore();
      }
      expect(
        await database.selectFrom("notification_pending").selectAll().execute(),
      ).toEqual([]);
      await actor.offerCommittedMessage(ref);
      const group = await database
        .selectFrom("notification_pending")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(await ctx.storage.getAlarm()).toBe(group.due_at);
    });
  });
  it("tracks enrollment, last-device removal and reenrollment across eviction", async () => {
    const s = await setup();
    await expectOfferPending(s.actor);
    await evictDurableObject(s.actor);
    await expectOfferPending(s.actor);
    const second = {
      ...s.enable,
      ...commandBase(1),
      deviceId: crypto.randomUUID(),
      subscription: await subscription(),
    };
    stateOf(await s.actor.command(s.principal, second));
    stateOf(
      await s.actor.command(s.principal, {
        ...commandBase(2),
        kind: "remove",
        deviceId: s.enable.deviceId,
        subscriptionVersion: 1,
      }),
    );
    await expectOfferPending(s.actor);
    stateOf(
      await s.actor.command(s.principal, {
        ...commandBase(3),
        kind: "remove",
        deviceId: second.deviceId,
        subscriptionVersion: 2,
      }),
    );
    await expectOfferSkipped(s.actor);
    await evictDurableObject(s.actor);
    await expectOfferSkipped(s.actor);
    stateOf(
      await s.actor.command(s.principal, {
        ...s.enable,
        ...commandBase(4),
      }),
    );
    await expectOfferPending(s.actor);
  });
  it("persists account keys, supports several devices and rejects expired management", async () => {
    const s = await setup();
    await evictDurableObject(s.actor);
    expect(stateOf(await s.actor.status(s.principal)).publicKey).toBe(
      s.state.publicKey,
    );
    const added = stateOf(
      await s.actor.command(s.principal, {
        ...s.enable,
        ...commandBase(1),
        deviceId: crypto.randomUUID(),
        subscription: await subscription(),
        label: "Phone",
      }),
    );
    expect(added.devices).toHaveLength(2);
    expect(added.preferences.language).toBe("ja");
    expect(await s.actor.status({ ...s.principal, expiresAt: 0 })).toEqual({
      kind: "unauthenticated",
    });
    // Enrollment survives expired login authority.
    expect(stateOf(await s.actor.status(s.principal)).devices).toHaveLength(2);
  });
  it("recovers exact commands without resurrecting removal and rejects delayed enable/preferences", async () => {
    const s = await setup();
    const removal = {
      ...commandBase(1),
      kind: "remove" as const,
      deviceId: s.enable.deviceId,
      subscriptionVersion: 1,
    };
    expect(
      stateOf(await s.actor.command(s.principal, removal)).devices,
    ).toHaveLength(0);
    const recovered = await s.actor.command(s.principal, s.enable);
    expect(recovered).toMatchObject({
      kind: "notification_updated",
      receipt: { revision: 1 },
      state: { revision: 2, devices: [] },
    });
    await expectOfferSkipped(s.actor);
    expect(
      await s.actor.command(s.principal, { ...s.enable, label: "Changed" }),
    ).toEqual({ kind: "command_conflict" });
    expect(
      await s.actor.command(s.principal, {
        ...s.enable,
        commandId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "stale_revision", currentRevision: 2 });
    expect(
      await s.actor.command(s.principal, {
        ...commandBase(1),
        kind: "preferences",
        paused: false,
        preview: "message",
        language: "ja",
      }),
    ).toEqual({ kind: "stale_revision", currentRevision: 2 });
    expect(
      await s.actor.command(s.principal, {
        ...s.enable,
        ...commandBase(2),
        issuedAt: Date.now() - 25 * 60 * 60_000,
      }),
    ).toEqual({ kind: "command_expired" });
  });
  it("dead endpoint feedback removes only the exact version and endpoint", async () => {
    const s = await setup();
    const replacement = {
      ...s.enable,
      ...commandBase(1),
      subscription: await subscription(),
    };
    const replaced = stateOf(await s.actor.command(s.principal, replacement));
    await s.actor.removeDeadSubscription(
      s.enable.deviceId,
      1,
      s.enable.subscription.endpoint,
    );
    await s.actor.removeDeadSubscription(
      s.enable.deviceId,
      replaced.revision,
      s.enable.subscription.endpoint,
    );
    expect(stateOf(await s.actor.status(s.principal)).devices).toHaveLength(1);
    await expectOfferPending(s.actor);
    await s.actor.removeDeadSubscription(
      s.enable.deviceId,
      replaced.revision,
      replacement.subscription.endpoint,
    );
    expect(stateOf(await s.actor.status(s.principal)).devices).toHaveLength(0);
    await expectOfferSkipped(s.actor);
  });
  it("persists bounded grouped waiting and a successor before consuming external work", async () => {
    const s = await setup();
    const first = reference();
    const offeredAt = Date.now();
    for (let i = 0; i < 35; i++)
      await s.actor.offerCommittedMessage({
        ...first,
        messageId: crypto.randomUUID(),
        sequence: i + 1,
      });
    const later = reference();
    await s.actor.offerCommittedMessage(later);
    await evictDurableObject(s.actor);
    await runInDurableObject(s.actor, async (_actor, ctx) => {
      const database = notificationDatabase(ctx.storage);
      const pending = await database
        .selectFrom("notification_pending")
        .selectAll()
        .where("room_key", "=", roomKey(first))
        .executeTakeFirstOrThrow();
      expect(JSON.parse(pending.references_json)).toHaveLength(32);
      expect(pending.due_at).toBeGreaterThanOrEqual(
        offeredAt + NOTIFICATION_GROUP_WAIT_MS,
      );
      await database
        .updateTable("notification_pending")
        .set({ due_at: Date.now() - 1 })
        .where("room_key", "=", roomKey(first))
        .execute();
      const consumed = await consumeDue(ctx.storage, database);
      expect(consumed).toHaveLength(1);
      expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(
        await database.selectFrom("notification_pending").selectAll().execute(),
      ).toHaveLength(1);
    });
  });
  it("does not postpone a due group when offers and commands overlap its deadline", async () => {
    const s = await setup();
    const ref = reference();
    await s.actor.offerCommittedMessage(ref);
    await runInDurableObject(s.actor, async (actor, ctx) => {
      const wake = (await ctx.storage.getAlarm())!;
      const clock = vi.spyOn(Date, "now").mockReturnValue(wake + 10);
      try {
        for (let index = 0; index < 3; index++) {
          await actor.offerCommittedMessage({
            ...ref,
            messageId: crypto.randomUUID(),
            sequence: index + 2,
          });
          expect(await ctx.storage.getAlarm()).toBe(wake);
        }
        await actor.command(s.principal, {
          ...commandBase(s.state.revision),
          kind: "preferences",
          paused: false,
          preview: "generic",
          language: "en",
        });
        expect(await ctx.storage.getAlarm()).toBe(wake);
        expect(
          await consumeDue(ctx.storage, notificationDatabase(ctx.storage)),
        ).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it.each(["eligibility", "enqueue"] as const)(
    "records a consumed group's %s failure without retrying it",
    async (failure) => {
      const s = await setup();
      const ref = reference();
      await s.actor.offerCommittedMessage(ref);
      await runInDurableObject(s.actor, async (_, ctx) => {
        const database = notificationDatabase(ctx.storage);
        await database
          .updateTable("notification_pending")
          .set({ due_at: Date.now() - 1 })
          .execute();
        const groups = await consumeDue(ctx.storage, database);
        const fixture = mockDispatch(async () => {
          if (failure === "eligibility") throw new Error("private details");
          return eligible(ref);
        }, []);
        vi.spyOn(fixture.PUSH_QUEUE, "sendBatch").mockRejectedValue(
          new Error("private endpoint"),
        );
        const diagnostics = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        try {
          await dispatchGroup(ctx, fixture, database, groups[0]!.room_key, [
            ref,
          ]);
          expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({
              event: "notification_dispatch_failed",
              failureReason: `${failure}_unavailable`,
            }),
          );
          expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
            "private",
          );
          expect(await consumeDue(ctx.storage, database)).toEqual([]);
        } finally {
          diagnostics.mockRestore();
        }
      });
    },
  );

  it("keeps ordinary room history out of preference capacity and bounds simultaneous waiting", async () => {
    const s = await setup();
    await runInDurableObject(s.actor, async (actor, ctx) => {
      const database = notificationDatabase(ctx.storage);
      for (let i = 0; i < 256; i++) {
        const ref = reference();
        await database
          .insertInto("notification_spacing")
          .values({ room_key: roomKey(ref), next_dispatch_at: Date.now() - 1 })
          .execute();
        await database
          .insertInto("notification_pending")
          .values({
            room_key: roomKey(ref),
            references_json: JSON.stringify([ref]),
            due_at: Date.now() + 10_000,
          })
          .execute();
      }
      const ref = reference();
      await actor.offerCommittedMessage(ref);
      expect(
        await database.selectFrom("notification_pending").selectAll().execute(),
      ).toHaveLength(256);
      expect(
        await database.selectFrom("notification_rooms").selectAll().execute(),
      ).toHaveLength(0);
      await consumeDue(ctx.storage, database);
      expect(
        await database.selectFrom("notification_spacing").selectAll().execute(),
      ).toHaveLength(0);
      await database.deleteFrom("notification_pending").execute();
      await actor.offerCommittedMessage(ref);
      expect(
        await database.selectFrom("notification_pending").selectAll().execute(),
      ).toHaveLength(1);
      const jobs: ReadyPushRequest[] = [];
      await dispatchGroup(
        ctx,
        mockDispatch(async () => eligible(ref), jobs),
        database,
        roomKey(ref),
        [ref],
      );
      expect(jobs).toHaveLength(1);
      expect(
        await database.selectFrom("notification_rooms").selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom("notification_spacing").selectAll().execute(),
      ).toHaveLength(1);
    });
  });
  it("returns a reset room to its implicit default and rejects tests for replaced enrollments", async () => {
    const s = await setup(),
      ref = reference();
    const preferences = stateOf(
      await s.actor.command(s.principal, {
        ...commandBase(1),
        kind: "room",
        owner: ref.owner,
        roomId: ref.roomId,
        mode: "all",
        mutedUntil: null,
      }),
    );
    expect(preferences.rooms).toHaveLength(1);
    const reset = stateOf(
      await s.actor.command(s.principal, {
        ...commandBase(2),
        kind: "room",
        owner: ref.owner,
        roomId: ref.roomId,
        mode: "direct",
        mutedUntil: null,
      }),
    );
    expect(reset.rooms).toHaveLength(0);
    await s.actor.command(s.principal, {
      ...s.enable,
      ...commandBase(3),
      subscription: await subscription(),
    });
    await runInDurableObject(s.actor, async (_actor, ctx) => {
      const database = notificationDatabase(ctx.storage),
        jobs: ReadyPushRequest[] = [];
      await dispatchGroup(
        ctx,
        mockDispatch(async () => null, jobs),
        database,
        "",
        [],
        { deviceId: s.enable.deviceId, subscriptionVersion: 1 },
      );
      expect(jobs).toHaveLength(0);
    });
  });
  it("prepares once without D1, uses fixed lifetimes and spaces subsequent new groups", async () => {
    const s = await setup();
    const ref = reference();
    await s.actor.offerCommittedMessage(ref);
    await runInDurableObject(s.actor, async (_actor, ctx) => {
      const database = notificationDatabase(ctx.storage),
        jobs: ReadyPushRequest[] = [];
      let resolves = 0;
      const fixture = mockDispatch(async () => {
        resolves++;
        return eligible(ref);
      }, jobs);
      const before = Date.now();
      await dispatchGroup(ctx, fixture, database, roomKey(ref), [ref]);
      expect(jobs).toHaveLength(1);
      expect(resolves).toBe(1);
      expect(jobs[0]?.expiresAt).toBe(
        ref.createdAt + NOTIFICATION_WORK_LIFETIME_MS,
      );
      expect(jobs[0]?.providerExpiresAt).toBe(ref.createdAt + 24 * 60 * 60_000);
      expect(jobs[0]?.body).not.toContain("Hello");
      const room = await database
        .selectFrom("notification_spacing")
        .selectAll()
        .where("room_key", "=", roomKey(ref))
        .executeTakeFirstOrThrow();
      expect(room.next_dispatch_at).toBeGreaterThanOrEqual(
        before + NOTIFICATION_ROOM_SPACING_MS,
      );
      await dispatchGroup(ctx, fixture, database, roomKey(ref), [ref]);
      expect(jobs).toHaveLength(1);
      expect(resolves).toBe(1);
    });
  });
  it("shares payload work across devices while encrypting each request independently", async () => {
    const s = await setup();
    for (const [index, deviceId] of [
      s.enable.deviceId,
      crypto.randomUUID(),
    ].entries())
      stateOf(
        await s.actor.command(s.principal, {
          ...s.enable,
          ...commandBase(index + 1),
          deviceId,
          subscription: {
            ...pushReceiver,
            endpoint: `${pushReceiver.endpoint}-${index}`,
          },
        }),
      );
    await runInDurableObject(s.actor, async (_, ctx) => {
      const ref = reference();
      const jobs: ReadyPushRequest[] = [];
      const database = notificationDatabase(ctx.storage);
      const digests = vi.spyOn(crypto.subtle, "digest");
      const imports = vi.spyOn(crypto.subtle, "importKey");
      try {
        await dispatchGroup(
          ctx,
          mockDispatch(async () => eligible(ref), jobs),
          database,
          roomKey(ref),
          [ref],
        );
        expect(jobs).toHaveLength(2);
        expect(digests).toHaveBeenCalledTimes(1);
        expect(
          imports.mock.calls.filter(
            ([format, , algorithm]) =>
              format === "raw" &&
              typeof algorithm === "object" &&
              algorithm.name === "ECDH",
          ),
        ).toHaveLength(2);
      } finally {
        digests.mockRestore();
        imports.mockRestore();
      }
      const plaintexts = await Promise.all(
        jobs.map((job) => decryptPush(decodePushBytes(job.body))),
      );
      expect(plaintexts[0]).toBe(plaintexts[1]);
      expect(jobs[0]!.body).not.toBe(jobs[1]!.body);
      expect(jobs[0]!.headers.topic).toBe(jobs[1]!.headers.topic);
    });
  });
  it.each(["remove", "pause", "room"] as const)(
    "invalidates awaited eligibility when %s commits and preserves a new successor",
    async (change) => {
      const s = await setup();
      const ref = reference();
      await s.actor.offerCommittedMessage(ref);
      const jobs: ReadyPushRequest[] = [];
      const gate = barrier();
      let entered = false;
      const fixture = mockDispatch(async () => {
        entered = true;
        await gate.promise;
        return eligible(ref);
      }, jobs);
      const dispatch = runInDurableObject(s.actor, (_, ctx) =>
        dispatchGroup(
          ctx,
          fixture,
          notificationDatabase(ctx.storage),
          roomKey(ref),
          [ref],
        ),
      );
      try {
        await expect.poll(() => entered).toBe(true);
        const command: NotificationCommand =
          change === "remove"
            ? {
                ...commandBase(1),
                kind: "remove",
                deviceId: s.enable.deviceId,
                subscriptionVersion: 1,
              }
            : change === "pause"
              ? {
                  ...commandBase(1),
                  kind: "preferences",
                  paused: true,
                  preview: "generic",
                  language: "en",
                }
              : {
                  ...commandBase(1),
                  kind: "room",
                  owner: ref.owner,
                  roomId: ref.roomId,
                  mode: "nothing",
                  mutedUntil: null,
                };
        expect((await s.actor.command(s.principal, command)).kind).toBe(
          "notification_updated",
        );
      } finally {
        gate.release();
        await dispatch;
      }
      expect(jobs).toHaveLength(0);
      await runInDurableObject(s.actor, async (_, ctx) => {
        expect(await ctx.storage.getAlarm()).not.toBeNull();
      });
    },
  );
  it("suppresses read/expired triggers and applies Direct/All and timed mute preferences", async () => {
    const s = await setup(),
      ref = reference();
    await s.actor.offerCommittedMessage(ref);
    await runInDurableObject(s.actor, async (actor, ctx) => {
      const database = notificationDatabase(ctx.storage),
        jobs: ReadyPushRequest[] = [];
      let resolves = 0;
      const fixture = mockDispatch(async (_accountId, _references, query) => {
        resolves++;
        expect(query.includeText).toBe(false);
        return query.directOnly ? null : { ...eligible(ref), trigger: "all" };
      }, jobs);
      await dispatchGroup(ctx, fixture, database, roomKey(ref), [ref]);
      expect(jobs).toHaveLength(0);
      await actor.command(s.principal, {
        ...commandBase(1),
        kind: "room",
        owner: ref.owner,
        roomId: ref.roomId,
        mode: "all",
        mutedUntil: Date.now() + 60_000,
      });
      await dispatchGroup(ctx, fixture, database, roomKey(ref), [ref]);
      expect(resolves).toBe(1);
      await actor.command(s.principal, {
        ...commandBase(2),
        kind: "room",
        owner: ref.owner,
        roomId: ref.roomId,
        mode: "all",
        mutedUntil: Date.now() - 1,
      });
      await dispatchGroup(ctx, fixture, database, roomKey(ref), [
        { ...ref, createdAt: Date.now() - NOTIFICATION_WORK_LIFETIME_MS },
      ]);
      expect(resolves).toBe(1);
      await dispatchGroup(ctx, fixture, database, roomKey(ref), [ref]);
      expect(jobs).toHaveLength(1);
    });
  });

  it("announces confirmed settings changes to the account's tabs without holding the command", async () => {
    const s = await setup(),
      ref = reference();
    await runInDurableObject(s.actor, async (actor, ctx) => {
      const actorEnv = (actor as unknown as { env: Env }).env;
      const deliveries: unknown[] = [];
      const background: Promise<unknown>[] = [];
      const waiter = vi.spyOn(ctx, "waitUntil").mockImplementation((work) => {
        background.push(work);
      });
      const hub = vi
        .spyOn(actorEnv.EVENT_DISPATCH, "getByName")
        .mockImplementation(
          () =>
            ({
              async deliver(input: unknown) {
                deliveries.push(input);
                throw new Error("Hub unavailable");
              },
            }) as unknown as ReturnType<Env["EVENT_DISPATCH"]["getByName"]>,
        );
      const room = (mode: "all" | "nothing") =>
        actor.command(s.principal, {
          ...commandBase(s.state.revision),
          kind: "room",
          owner: ref.owner,
          roomId: ref.roomId,
          mode,
          mutedUntil: null,
        });
      try {
        expect(stateOf(await room("all")).rooms).toHaveLength(1);
        // A rejected command changes nothing and announces nothing.
        expect(
          NotificationOutcomeSchema.parse(await room("nothing")).kind,
        ).toBe("stale_revision");
        await Promise.all(background);
      } finally {
        hub.mockRestore();
        waiter.mockRestore();
      }
      expect(deliveries).toEqual([
        {
          recipients: [s.principal.userId],
          notice: { type: "notification_settings" },
        },
      ]);
    });
  });
});
