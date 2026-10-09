import {
  NOTIFICATION_DEVICE_LIMIT,
  NOTIFICATION_ROOM_LIMIT,
  type NotificationCommand,
  type NotificationPreferences,
  type NotificationOutcome,
} from "@vaskel/contracts/notifications";
import type { Principal } from "@/server/domain/principal";
import { principalFailure } from "@/server/actors/shared/policy";
import { commandWindowFailure } from "@/server/actors/shared/message-command";
import { sha256Hex } from "@/server/auth/crypto";
import { validatePushSubscription } from "@/server/notifications/web-push";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  RECEIPT_RETENTION_MS,
  retentionWake,
} from "@/server/actors/shared/retention";
import { accountState, publicState, roomKey, type Database } from "./store";

export async function applyCommand(
  storage: DurableObjectStorage,
  database: Database,
  principal: Principal,
  command: NotificationCommand,
): Promise<{
  outcome: NotificationOutcome;
  testDevice?: { deviceId: string; subscriptionVersion: number };
}> {
  const hash = await sha256Hex(JSON.stringify(command));
  if (
    command.kind === "enable" &&
    !(await validatePushSubscription(command.subscription))
  )
    return { outcome: { kind: "invalid_input" } };
  return storage.transaction(async () => {
    const invalid =
      principalFailure(principal) ??
      commandWindowFailure(command.issuedAt, Date.now());
    if (invalid) return { outcome: invalid };
    const account = (await accountState(database))!;
    const previous = await database
      .selectFrom("notification_commands")
      .selectAll()
      .where("command_id", "=", command.commandId)
      .executeTakeFirst();
    if (previous)
      return {
        outcome:
          previous.payload_hash === hash
            ? {
                kind: "notification_updated",
                receipt: {
                  commandId: command.commandId,
                  revision: previous.revision,
                },
                state: await publicState(database),
              }
            : { kind: "command_conflict" },
      };
    if (command.expectedRevision !== account.revision)
      return {
        outcome: { kind: "stale_revision", currentRevision: account.revision },
      };
    const revision = account.revision + 1;
    if (command.kind === "enable") {
      const devices = await database
        .selectFrom("notification_devices")
        .selectAll()
        .execute();
      const existing = devices.find((d) => d.device_id === command.deviceId);
      if (!existing && devices.length >= NOTIFICATION_DEVICE_LIMIT)
        return { outcome: { kind: "capacity" } };
      // One subscription cannot silently acquire a second local device identity.
      if (
        devices.some(
          (d) =>
            d.device_id !== command.deviceId &&
            JSON.parse(d.subscription_json).endpoint ===
              command.subscription.endpoint,
        )
      )
        return { outcome: { kind: "command_conflict" } };
      const row = {
        device_id: command.deviceId,
        label: command.label,
        version: revision,
        subscription_json: JSON.stringify(command.subscription),
        created_at: existing?.created_at ?? Date.now(),
      };
      await database
        .updateTable("notification_account")
        .set({
          preferences_json: JSON.stringify({
            ...(JSON.parse(
              account.preferences_json,
            ) as NotificationPreferences),
            language: command.language,
          }),
        })
        .where("id", "=", 1)
        .execute();
      await database
        .insertInto("notification_devices")
        .values(row)
        .onConflict((c) => c.column("device_id").doUpdateSet(row))
        .execute();
    } else if (command.kind === "remove" || command.kind === "test") {
      const device = await database
        .selectFrom("notification_devices")
        .selectAll()
        .where("device_id", "=", command.deviceId)
        .executeTakeFirst();
      if (!device || device.version !== command.subscriptionVersion)
        return { outcome: { kind: "not_found" } };
      if (command.kind === "remove")
        await database
          .deleteFrom("notification_devices")
          .where("device_id", "=", command.deviceId)
          .execute();
    } else if (command.kind === "preferences") {
      const preferences = {
        paused: command.paused,
        preview: command.preview,
        language: command.language,
      };
      await database
        .updateTable("notification_account")
        .set({ preferences_json: JSON.stringify(preferences) })
        .where("id", "=", 1)
        .execute();
      if (command.paused)
        await database.deleteFrom("notification_pending").execute();
    } else {
      const key = roomKey(command);
      const existing = await database
        .selectFrom("notification_rooms")
        .selectAll()
        .where("room_key", "=", key)
        .executeTakeFirst();
      const count = await database
        .selectFrom("notification_rooms")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirstOrThrow();
      const reset = command.mode === "direct" && command.mutedUntil === null;
      if (!reset && !existing && count.n >= NOTIFICATION_ROOM_LIMIT)
        return { outcome: { kind: "capacity" } };
      const preference = {
        owner: command.owner,
        roomId: command.roomId,
        mode: command.mode,
        mutedUntil: command.mutedUntil,
      };
      if (reset)
        await database
          .deleteFrom("notification_rooms")
          .where("room_key", "=", key)
          .execute();
      else
        await database
          .insertInto("notification_rooms")
          .values({
            room_key: key,
            preference_json: JSON.stringify(preference),
          })
          .onConflict((c) =>
            c
              .column("room_key")
              .doUpdateSet({ preference_json: JSON.stringify(preference) }),
          )
          .execute();
      if (command.mode === "nothing" || (command.mutedUntil ?? 0) > Date.now())
        await database
          .deleteFrom("notification_pending")
          .where("room_key", "=", key)
          .execute();
    }
    await database
      .updateTable("notification_account")
      .set({ revision })
      .where("id", "=", 1)
      .execute();
    const acceptedAt = Date.now();
    await database
      .insertInto("notification_commands")
      .values({
        command_id: command.commandId,
        payload_hash: hash,
        revision,
        accepted_at: acceptedAt,
      })
      .execute();
    await scheduleAlarm(
      storage,
      retentionWake(acceptedAt, RECEIPT_RETENTION_MS),
    );
    return {
      outcome: {
        kind: "notification_updated",
        receipt: { commandId: command.commandId, revision },
        state: await publicState(database),
      },
      ...(command.kind === "test"
        ? {
            testDevice: {
              deviceId: command.deviceId,
              subscriptionVersion: command.subscriptionVersion,
            },
          }
        : {}),
    };
  });
}
