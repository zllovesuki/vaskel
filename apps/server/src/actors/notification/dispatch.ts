import type {
  NotificationEligibleMessage,
  NotificationMessageReference,
} from "@/server/notifications/protocol";
import {
  NOTIFICATION_PROVIDER_LIFETIME_MS,
  NOTIFICATION_ROOM_SPACING_MS,
  NOTIFICATION_WORK_LIFETIME_MS,
  type NotificationPreferences,
  type NotificationRoomPreference,
} from "@vaskel/contracts/notifications";
import {
  actorWork,
  ACTOR_WORK_BUDGET_MS,
} from "@/server/actors/shared/bounded-work";
import { selectNotificationMessage } from "@/server/notifications/source";
import {
  preparePushRequest,
  preparePushPayload,
  type VapidKeys,
} from "@/server/notifications/web-push";
import type { ReadyPushRequest } from "@/server/notifications/transport";
import {
  roomPreference,
  pruneExpiredSpacing,
  accountState,
  subscriptionOf,
  type Database,
} from "./store";
import { notificationPayload } from "./presentation";
import { logEvent } from "@/server/telemetry";

export async function dispatchGroup(
  ctx: DurableObjectState,
  env: Env,
  database: Database,
  roomKey: string,
  references: NotificationMessageReference[],
  testDevice?: { deviceId: string; subscriptionVersion: number },
) {
  const started = Date.now();
  const capture = await ctx.storage.transaction(async () => {
    const account = await accountState(database);
    if (!account) return null;
    const preferences = JSON.parse(
      account.preferences_json,
    ) as NotificationPreferences;
    if (preferences.paused && !testDevice) return null;
    const room = await database
      .selectFrom("notification_rooms")
      .selectAll()
      .where("room_key", "=", roomKey)
      .executeTakeFirst();
    const preference = room
      ? (JSON.parse(room.preference_json) as NotificationRoomPreference)
      : references[0]
        ? roomPreference(references[0])
        : null;
    const spacing = await database
      .selectFrom("notification_spacing")
      .selectAll()
      .where("room_key", "=", roomKey)
      .executeTakeFirst();
    if (
      !testDevice &&
      (!preference ||
        preference.mode === "nothing" ||
        (preference.mutedUntil ?? 0) > Date.now() ||
        (spacing?.next_dispatch_at ?? 0) > Date.now())
    )
      return null;
    const devices = await database
      .selectFrom("notification_devices")
      .selectAll()
      .execute();
    return {
      account,
      preferences,
      preference,
      devices: devices.filter(
        (d) =>
          !testDevice ||
          (d.device_id === testDevice.deviceId &&
            d.version === testDevice.subscriptionVersion),
      ),
    };
  });
  if (!capture || capture.devices.length === 0) return;
  let message: NotificationEligibleMessage | null = null;
  if (!testDevice) {
    const fresh = references.filter(
      (r) => r.createdAt + NOTIFICATION_WORK_LIFETIME_MS > Date.now(),
    );
    if (!fresh.length) return;
    const result = await actorWork(ctx.storage, "maintenance").run(
      () =>
        selectNotificationMessage(env, capture.account.account_id, fresh, {
          directOnly: capture.preference?.mode !== "all",
          includeText: capture.preferences.preview === "message",
        }),
      started + ACTOR_WORK_BUDGET_MS,
      roomKey,
    );
    if (!result.ok) {
      logEvent("warn", "notification_dispatch_failed", {
        actorId: ctx.id.toString(),
        failureReason: "eligibility_unavailable",
        processed: references.length,
        durationMs: Date.now() - started,
      });
      return;
    }
    message = result.value;
    if (!message) {
      logEvent("log", "notification_dispatch", {
        actorId: ctx.id.toString(),
        processed: references.length,
        sent: 0,
        suppressed: references.length,
        durationMs: Date.now() - started,
      });
      return;
    }
  }
  const createdAt = message?.reference.createdAt ?? started;
  const payload = notificationPayload(
    capture.account.account_id,
    capture.preferences,
    message,
  );
  const preparedPayload = preparePushPayload(payload);
  const vapidKeys = JSON.parse(capture.account.vapid_json) as VapidKeys;
  const requests = await Promise.all(
    capture.devices.map(async (device) => {
      try {
        const prepared = await preparePushRequest({
          subscription: subscriptionOf(device),
          payload: await preparedPayload,
          vapidKeys,
          expiresAt: createdAt + NOTIFICATION_WORK_LIFETIME_MS,
          providerExpiresAt: createdAt + NOTIFICATION_PROVIDER_LIFETIME_MS,
          subject: env.PUSH_VAPID_SUBJECT?.trim() || env.AUTH_ORIGIN,
        });
        return {
          ...prepared,
          accountId: capture.account.account_id,
          deviceId: device.device_id,
          subscriptionVersion: device.version,
        } satisfies ReadyPushRequest;
      } catch {
        return null;
      }
    }),
  );
  const jobs = requests.filter((r): r is ReadyPushRequest => r !== null);
  if (jobs.length < requests.length)
    logEvent("warn", "notification_dispatch_failed", {
      actorId: ctx.id.toString(),
      failureReason: "preparation_failed",
      failed: requests.length - jobs.length,
    });
  if (!jobs.length) return;
  // The final local decision fences preference/removal changes during owner or crypto awaits.
  const committed = await ctx.storage.transaction(async () => {
    const current = await database
      .selectFrom("notification_account")
      .select("revision")
      .where("id", "=", 1)
      .executeTakeFirst();
    if (
      !current ||
      current.revision !== capture.account.revision ||
      createdAt + NOTIFICATION_WORK_LIFETIME_MS <= Date.now()
    )
      return false;
    if (!testDevice) {
      const spacing = await database
        .selectFrom("notification_spacing")
        .selectAll()
        .where("room_key", "=", roomKey)
        .executeTakeFirst();
      if ((spacing?.next_dispatch_at ?? 0) > Date.now()) return false;
      await pruneExpiredSpacing(database, Date.now());
      const next = Date.now() + NOTIFICATION_ROOM_SPACING_MS;
      await database
        .insertInto("notification_spacing")
        .values({ room_key: roomKey, next_dispatch_at: next })
        .onConflict((c) =>
          c.column("room_key").doUpdateSet({ next_dispatch_at: next }),
        )
        .execute();
      await database
        .updateTable("notification_pending")
        .set({ due_at: next })
        .where("room_key", "=", roomKey)
        .where("due_at", "<", next)
        .execute();
    }
    return true;
  });
  if (!committed) return;
  // No authorization is reloaded after this boundary. Transport can repeat or lose requests.
  const queued = await actorWork(ctx.storage, "maintenance").run(
    () =>
      env.PUSH_QUEUE.sendBatch(
        jobs.map((body) => ({ body, contentType: "json" as const })),
      ),
    Date.now() + ACTOR_WORK_BUDGET_MS,
  );
  if (!queued.ok)
    logEvent("warn", "notification_dispatch_failed", {
      actorId: ctx.id.toString(),
      failureReason: "enqueue_unavailable",
      failed: jobs.length,
    });
  logEvent("log", "notification_dispatch", {
    actorId: ctx.id.toString(),
    processed: references.length,
    sent: queued.ok ? jobs.length : 0,
    suppressed: 0,
    durationMs: Date.now() - started,
  });
}
