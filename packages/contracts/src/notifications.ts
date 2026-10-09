import { z } from "zod";
import { OwnerScopeSchema } from "./messaging";
import { UiLanguageSchema } from "./preferences";

export const NOTIFICATION_GROUP_WAIT_MS = 10_000;
export const NOTIFICATION_ROOM_SPACING_MS = 60_000;
export const NOTIFICATION_WORK_LIFETIME_MS = 15 * 60_000;
export const NOTIFICATION_PROVIDER_LIFETIME_MS = 24 * 60 * 60_000;
export const NOTIFICATION_GROUP_LIMIT = 32;
export const NOTIFICATION_DEVICE_LIMIT = 16;
export const NOTIFICATION_ROOM_LIMIT = 256;
export const NOTIFICATION_PENDING_LIMIT = 256;
export const PushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
export const NotificationPreferencesSchema = z.strictObject({
  paused: z.boolean(),
  preview: z.enum(["generic", "who-and-where", "message"]),
  language: UiLanguageSchema,
});
export type NotificationPreferences = z.infer<
  typeof NotificationPreferencesSchema
>;
export const NotificationRoomPreferenceSchema = z.strictObject({
  owner: OwnerScopeSchema,
  roomId: z.uuid(),
  mode: z.enum(["direct", "all", "nothing"]),
  mutedUntil: z.number().int().nonnegative().nullable(),
});
export type NotificationRoomPreference = z.infer<
  typeof NotificationRoomPreferenceSchema
>;
const commandFields = {
  commandId: z.uuid(),
  issuedAt: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(),
};
export const NotificationCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commandFields,
    kind: z.literal("enable"),
    language: UiLanguageSchema,
    deviceId: z.uuid(),
    label: z.string().trim().min(1).max(80),
    subscription: PushSubscriptionSchema,
  }),
  z.strictObject({
    ...commandFields,
    kind: z.literal("remove"),
    deviceId: z.uuid(),
    subscriptionVersion: z.number().int().positive(),
  }),
  z.strictObject({
    ...commandFields,
    kind: z.literal("preferences"),
    ...NotificationPreferencesSchema.shape,
  }),
  z.strictObject({
    ...commandFields,
    kind: z.literal("room"),
    ...NotificationRoomPreferenceSchema.shape,
  }),
  z.strictObject({
    ...commandFields,
    kind: z.literal("test"),
    deviceId: z.uuid(),
    subscriptionVersion: z.number().int().positive(),
  }),
]);
export type NotificationCommand = z.infer<typeof NotificationCommandSchema>;
export const NotificationDeviceSchema = z.strictObject({
  deviceId: z.uuid(),
  label: z.string().max(80),
  subscriptionVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
});
export type NotificationDevice = z.infer<typeof NotificationDeviceSchema>;
export const NotificationStateSchema = z.strictObject({
  accountId: z.uuid(),
  revision: z.number().int().nonnegative(),
  publicKey: z.string(),
  preferences: NotificationPreferencesSchema,
  devices: z.array(NotificationDeviceSchema).max(NOTIFICATION_DEVICE_LIMIT),
  rooms: z.array(NotificationRoomPreferenceSchema).max(NOTIFICATION_ROOM_LIMIT),
});
export type NotificationState = z.infer<typeof NotificationStateSchema>;
export const NotificationOutcomeSchema = z.union([
  z.strictObject({
    kind: z.literal("notification_state"),
    state: NotificationStateSchema,
  }),
  z.strictObject({
    kind: z.literal("notification_updated"),
    receipt: z.strictObject({
      commandId: z.uuid(),
      revision: z.number().int().positive(),
    }),
    state: NotificationStateSchema,
  }),
  z.strictObject({
    kind: z.enum([
      "invalid_input",
      "unauthenticated",
      "forbidden",
      "not_found",
      "command_conflict",
      "command_expired",
      "capacity",
    ]),
  }),
  z.strictObject({
    kind: z.literal("stale_revision"),
    currentRevision: z.number().int().nonnegative(),
  }),
]);
export type NotificationOutcome = z.infer<typeof NotificationOutcomeSchema>;

export {
  NotificationPayloadSchema,
  type NotificationPayload,
} from "./notification-payload";
