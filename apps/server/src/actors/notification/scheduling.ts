import type { NotificationMessageReference } from "@/server/notifications/protocol";
import { sql } from "kysely";
import {
  NOTIFICATION_GROUP_LIMIT,
  NOTIFICATION_GROUP_WAIT_MS,
  NOTIFICATION_PENDING_LIMIT,
  NOTIFICATION_WORK_LIFETIME_MS,
  type NotificationPreferences,
  type NotificationRoomPreference,
} from "@vaskel/contracts/notifications";
import {
  RECEIPT_RETENTION_MS,
  retentionWake,
} from "@/server/actors/shared/retention";
import { replaceAlarm, scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  pruneExpiredSpacing,
  roomKey,
  roomPreference,
  type Database,
} from "./store";

/** Complete current schedule; callers hold the actor's native transaction. */
export async function refreshSchedule(
  storage: DurableObjectStorage,
  database: Database,
) {
  const pending = await database
    .selectFrom("notification_pending")
    .select((eb) => eb.fn.min("due_at").as("due"))
    .executeTakeFirstOrThrow();
  const receipt = await database
    .selectFrom("notification_commands")
    .select((eb) => eb.fn.min("accepted_at").as("at"))
    .executeTakeFirstOrThrow();
  const deadlines = [
    pending.due,
    receipt.at === null
      ? null
      : retentionWake(receipt.at, RECEIPT_RETENTION_MS),
  ].filter((n): n is number => n !== null);
  await replaceAlarm(
    storage,
    deadlines.length
      ? Math.max(Date.now() + 1000, Math.min(...deadlines))
      : null,
  );
}
function currentOffer(reference: NotificationMessageReference, now: number) {
  return (
    reference.createdAt + NOTIFICATION_WORK_LIFETIME_MS > now &&
    reference.createdAt <= now + 30_000
  );
}

export async function offerMessage(
  storage: DurableObjectStorage,
  database: Database,
  reference: NotificationMessageReference,
) {
  if (!currentOffer(reference, Date.now())) return;
  await storage.transaction(async () => {
    const now = Date.now();
    if (!currentOffer(reference, now)) return;
    const account = await database
      .selectFrom("notification_account")
      .select("preferences_json")
      .select((eb) =>
        eb
          .exists(eb.selectFrom("notification_devices").select("device_id"))
          .as("has_devices"),
      )
      .where("id", "=", 1)
      .executeTakeFirst();
    if (
      !account ||
      !account.has_devices ||
      (JSON.parse(account.preferences_json) as NotificationPreferences).paused
    )
      return;
    const key = roomKey(reference);
    const room = await database
      .selectFrom("notification_rooms")
      .selectAll()
      .where("room_key", "=", key)
      .executeTakeFirst();
    const preference = room
      ? (JSON.parse(room.preference_json) as NotificationRoomPreference)
      : roomPreference(reference);
    if (preference.mode === "nothing" || (preference.mutedUntil ?? 0) > now)
      return;
    const existing = await database
      .selectFrom("notification_pending")
      .selectAll()
      .where("room_key", "=", key)
      .executeTakeFirst();
    let dueAt = existing?.due_at ?? now + NOTIFICATION_GROUP_WAIT_MS;
    if (!existing) {
      const count = await database
        .selectFrom("notification_pending")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirstOrThrow();
      if (count.n >= NOTIFICATION_PENDING_LIMIT) return;
      const spacing = await database
        .selectFrom("notification_spacing")
        .select("next_dispatch_at")
        .where("room_key", "=", key)
        .executeTakeFirst();
      dueAt = Math.max(dueAt, spacing?.next_dispatch_at ?? 0);
    }
    const references: NotificationMessageReference[] = existing
      ? JSON.parse(existing.references_json)
      : [];
    if (
      references.some(
        (r) =>
          r.messageId === reference.messageId &&
          r.ownerGeneration === reference.ownerGeneration,
      )
    )
      return;
    references.push(reference);
    const row = {
      room_key: key,
      references_json: JSON.stringify(
        references
          .filter((r) => r.createdAt + NOTIFICATION_WORK_LIFETIME_MS > now)
          .slice(-NOTIFICATION_GROUP_LIMIT),
      ),
      due_at: dueAt,
    };
    // RETURNING avoids the adapter's otherwise unused changes()/last_insert_rowid() reads.
    const stored = await database
      .insertInto("notification_pending")
      .values(row)
      .onConflict((c) => c.column("room_key").doUpdateSet(row))
      .returning("due_at")
      .executeTakeFirstOrThrow();
    // An existing group already has a durable wake; appending does not change it.
    if (!existing) await scheduleAlarm(storage, stored.due_at);
  });
}
export async function consumeDue(
  storage: DurableObjectStorage,
  database: Database,
) {
  return storage.transaction(async () => {
    const now = Date.now();
    await sql`DELETE FROM notification_commands WHERE command_id IN (SELECT command_id FROM notification_commands WHERE accepted_at <= ${now - RECEIPT_RETENTION_MS} ORDER BY accepted_at LIMIT 200)`.execute(
      database,
    );
    await pruneExpiredSpacing(database, now);
    const groups = await database
      .selectFrom("notification_pending")
      .selectAll()
      .where("due_at", "<=", now)
      .orderBy("due_at")
      .limit(4)
      .execute();
    for (const group of groups)
      await database
        .deleteFrom("notification_pending")
        .where("room_key", "=", group.room_key)
        .execute();
    // Persist successors before the first owner/provider await. Consumed alerts may be lost.
    await refreshSchedule(storage, database);
    return groups;
  });
}
