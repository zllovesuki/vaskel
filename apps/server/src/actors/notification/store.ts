import type { NotificationMessageReference } from "@/server/notifications/protocol";
import migration from "./migrations/0001_initial.sql?raw";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";
import type {
  NotificationPreferences,
  NotificationRoomPreference,
  NotificationState,
  PushSubscription,
} from "@vaskel/contracts/notifications";
import type { VapidKeys } from "@/server/notifications/web-push";

export interface NotificationDatabase {
  notification_account: {
    id: number;
    account_id: string;
    revision: number;
    preferences_json: string;
    vapid_json: string;
  };
  notification_devices: {
    device_id: string;
    label: string;
    version: number;
    subscription_json: string;
    created_at: number;
  };
  notification_rooms: {
    room_key: string;
    preference_json: string;
  };
  notification_spacing: { room_key: string; next_dispatch_at: number };
  notification_commands: {
    command_id: string;
    payload_hash: string;
    revision: number;
    accepted_at: number;
  };
  notification_pending: {
    room_key: string;
    references_json: string;
    due_at: number;
  };
}
export function notificationDatabase(
  storage: DurableObjectStorage,
  actorId?: string,
) {
  migrateActorStorage(
    storage,
    [{ version: 1, name: "account-notifications", sql: migration }],
    { schema: "notification", actorId },
  );
  return createActorDatabase<NotificationDatabase>(storage);
}
export type Database = ReturnType<typeof notificationDatabase>;
export const roomKey = (
  room: Pick<NotificationMessageReference, "owner" | "roomId">,
) => `${room.owner.kind}:${room.owner.id}:${room.roomId}`;
export const defaultPreferences: NotificationPreferences = {
  paused: false,
  preview: "generic",
  language: "en",
};
export const roomPreference = (
  room: Pick<NotificationMessageReference, "owner" | "roomId">,
): NotificationRoomPreference => ({
  owner: room.owner,
  roomId: room.roomId,
  mode: "direct",
  mutedUntil: null,
});
export async function accountState(database: Database) {
  return database
    .selectFrom("notification_account")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
}
export async function publicState(
  database: Database,
): Promise<NotificationState> {
  const account = (await accountState(database))!;
  const devices = await database
    .selectFrom("notification_devices")
    .selectAll()
    .orderBy("created_at")
    .execute();
  const rooms = await database
    .selectFrom("notification_rooms")
    .selectAll()
    .orderBy("room_key")
    .execute();
  return {
    accountId: account.account_id,
    revision: account.revision,
    publicKey: (JSON.parse(account.vapid_json) as VapidKeys).publicKey,
    preferences: JSON.parse(
      account.preferences_json,
    ) as NotificationPreferences,
    devices: devices.map((d) => ({
      deviceId: d.device_id,
      label: d.label,
      subscriptionVersion: d.version,
      createdAt: d.created_at,
    })),
    rooms: rooms.map(
      (r) => JSON.parse(r.preference_json) as NotificationRoomPreference,
    ),
  };
}
export function subscriptionOf(
  device: NotificationDatabase["notification_devices"],
): PushSubscription {
  return JSON.parse(device.subscription_json) as PushSubscription;
}

/** Spacing expires independently of explicit room preferences. */
export async function pruneExpiredSpacing(database: Database, now: number) {
  await database
    .deleteFrom("notification_spacing")
    .where("next_dispatch_at", "<=", now)
    .execute();
}
