import { z } from "zod";
import { OwnerScopeSchema } from "./messaging";

const id = z.string().min(1).max(128);
const version = z.number().int().nonnegative();
const time = version;
export const MediaRoomRefSchema = z.strictObject({
  owner: OwnerScopeSchema,
  channelId: id,
});
export type MediaRoomRef = z.infer<typeof MediaRoomRefSchema>;
export const MediaSourceSchema = z.enum([
  "microphone",
  "camera",
  "screen_video",
  "screen_audio",
]);
export type MediaSource = z.infer<typeof MediaSourceSchema>;
export const MediaDescriptionSchema = z.strictObject({
  type: z.enum(["offer", "answer"]),
  sdp: z
    .string()
    .min(1)
    .refine((sdp) => new TextEncoder().encode(sdp).byteLength <= 256 * 1024),
});
export const MediaHandleSchema = z.strictObject({
  room: MediaRoomRefSchema,
  participantId: id,
  accountGeneration: version.min(1),
  clientId: z.uuid(),
  deviceToken: z.string().regex(/^[0-9a-f]{64}$/),
});
export type MediaHandle = z.infer<typeof MediaHandleSchema>;
export const JoinMediaRequestSchema = z.strictObject({
  room: MediaRoomRefSchema,
  clientId: z.uuid(),
  deviceToken: MediaHandleSchema.shape.deviceToken,
  commandId: z.uuid(),
  issuedAt: time,
  expectedGeneration: version,
});
export type JoinMediaRequest = z.infer<typeof JoinMediaRequestSchema>;
const HandleCommandSchema = z.strictObject({
  handle: MediaHandleSchema,
  commandId: z.uuid(),
  issuedAt: time,
});
export const ResumeMediaRequestSchema = HandleCommandSchema.extend({
  nextDeviceToken: MediaHandleSchema.shape.deviceToken,
}).refine(
  (request) => request.nextDeviceToken !== request.handle.deviceToken,
  "Resume rotates the endpoint capability.",
);
export type ResumeMediaRequest = z.infer<typeof ResumeMediaRequestSchema>;
export const PendingMediaCommandSchema = z.discriminatedUnion("path", [
  z.strictObject({
    path: z.enum(["join", "transfer"]),
    body: JoinMediaRequestSchema,
  }),
  z.strictObject({ path: z.literal("resume"), body: ResumeMediaRequestSchema }),
]);
export type PendingMediaCommand = z.infer<typeof PendingMediaCommandSchema>;
export const LeaveMediaRequestSchema = z.union([
  HandleCommandSchema,
  z.strictObject({
    pending: PendingMediaCommandSchema,
    commandId: z.uuid(),
    issuedAt: time,
  }),
]);
export type LeaveMediaRequest = z.infer<typeof LeaveMediaRequestSchema>;
export const HeartbeatMediaRequestSchema = z.strictObject({
  handle: MediaHandleSchema,
});
export type HeartbeatMediaRequest = z.infer<typeof HeartbeatMediaRequestSchema>;
const mutation = {
  handle: MediaHandleSchema,
  operationId: z.uuid(),
  issuedAt: time,
  expectedSessionVersion: version,
};
export const PublishMediaRequestSchema = z.strictObject({
  ...mutation,
  sessionDescription: MediaDescriptionSchema.refine(
    (sdp) => sdp.type === "offer",
  ),
  tracks: z
    .array(z.strictObject({ source: MediaSourceSchema, mid: id }))
    .min(1)
    .max(4),
});
export type PublishMediaRequest = z.infer<typeof PublishMediaRequestSchema>;
export const SubscribeMediaRequestSchema = z.strictObject({
  ...mutation,
  publicationIds: z.array(z.uuid()).max(60),
});
export type SubscribeMediaRequest = z.infer<typeof SubscribeMediaRequestSchema>;
export const AckMediaRequestSchema = z.strictObject({
  handle: MediaHandleSchema,
  operationId: z.uuid(),
  expectedSessionVersion: version,
});
export type AckMediaRequest = z.infer<typeof AckMediaRequestSchema>;
export const AnswerMediaRequestSchema = AckMediaRequestSchema.extend({
  sessionDescription: MediaDescriptionSchema.refine(
    (sdp) => sdp.type === "answer",
  ),
});
export type AnswerMediaRequest = z.infer<typeof AnswerMediaRequestSchema>;
export const UnpublishMediaRequestSchema = z.strictObject({
  ...mutation,
  sources: z.array(MediaSourceSchema).min(1).max(4),
});
export type UnpublishMediaRequest = z.infer<typeof UnpublishMediaRequestSchema>;
export const ModerateMediaRequestSchema = z.strictObject({
  room: MediaRoomRefSchema,
  userId: id,
  action: z.enum(["mute", "deafen", "remove", "screen_revoke"]),
  enabled: z.boolean(),
  commandId: z.uuid(),
  participantGeneration: version.min(1),
  expectedControlVersion: version,
});
export type ModerateMediaRequest = z.infer<typeof ModerateMediaRequestSchema>;
export const MediaPublicationSchema = z.strictObject({
  id: z.uuid(),
  participantId: id,
  source: MediaSourceSchema,
  generation: version.min(1),
});
export type MediaPublication = z.infer<typeof MediaPublicationSchema>;
export const MediaSubscriptionSchema = z.strictObject({
  publication: MediaPublicationSchema,
  mid: id,
});
export type MediaSubscription = z.infer<typeof MediaSubscriptionSchema>;
export const MediaParticipantSchema = z.strictObject({
  id,
  userId: id,
  generation: version.min(1),
  controlVersion: version,
  muted: z.boolean(),
  deafened: z.boolean(),
  screenRevoked: z.boolean(),
  status: z.enum(["joining", "active", "closing"]),
  publications: z.array(MediaPublicationSchema).max(4),
});
export const MediaSnapshotSchema = z.strictObject({
  room: MediaRoomRefSchema,
  revision: version,
  participants: z.array(MediaParticipantSchema).max(16),
});
export type MediaSnapshot = z.infer<typeof MediaSnapshotSchema>;
export const MediaRecoveryReasonSchema = z.enum([
  "transport_closed",
  "admission_failed",
  "lease_expired",
  "negotiation_expired",
]);
export type MediaRecoveryReason = z.infer<typeof MediaRecoveryReasonSchema>;
export const MediaEndReasonSchema = z.enum([
  "removed",
  "permission_revoked",
  "left",
]);
export type MediaEndReason = z.infer<typeof MediaEndReasonSchema>;
export const MediaFailureSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("recovery_required"),
    handle: MediaHandleSchema,
    reason: MediaRecoveryReasonSchema,
  }),
  z.strictObject({
    kind: z.literal("participation_ended"),
    generation: version.min(1),
    reason: MediaEndReasonSchema,
  }),
  z.strictObject({
    kind: z.literal("action_restricted"),
    restriction: z.enum(["mute", "deafen", "camera", "screen"]),
  }),
  z.strictObject({ kind: z.literal("publication_unavailable") }),
  z.strictObject({ kind: z.literal("moderation_changed") }),
  z.strictObject({
    kind: z.enum([
      "unauthenticated",
      "forbidden",
      "unavailable",
      "invalid_input",
      "not_found",
      "command_conflict",
      "command_expired",
      "capacity",
      "negotiation_expired",
    ]),
  }),
  z.strictObject({
    kind: z.literal("stale_generation"),
    currentGeneration: version,
  }),
  z.strictObject({ kind: z.literal("stale_version"), currentVersion: version }),
  z.strictObject({
    kind: z.literal("transfer_required"),
    currentGeneration: version,
    room: MediaRoomRefSchema,
  }),
  z.strictObject({ kind: z.literal("cleanup_pending"), generation: version }),
  z.strictObject({ kind: z.literal("session_busy"), operationId: z.uuid() }),
  z.strictObject({
    kind: z.literal("provider_error"),
    code: z.string().max(80),
    retryable: z.boolean(),
    uncertain: z.boolean(),
  }),
]);
export type MediaFailure = z.infer<typeof MediaFailureSchema>;
export const MediaOutcomeSchema = z.union([
  MediaFailureSchema,
  z.strictObject({
    kind: z.literal("media_status"),
    generation: version,
    admission: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("available") }),
      z.strictObject({
        kind: z.literal("resumable"),
        room: MediaRoomRefSchema,
      }),
      z.strictObject({
        kind: z.literal("transfer_required"),
        room: MediaRoomRefSchema,
      }),
      z.strictObject({ kind: z.literal("cleanup_pending") }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("joined"),
    handle: MediaHandleSchema,
    generation: version.min(1),
    producerVersion: version,
    consumerVersion: version,
    snapshot: MediaSnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal("left"),
    generation: version,
    cleanupPending: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("media_snapshot"),
    snapshot: MediaSnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal("heartbeat"),
    expiresAt: time,
    snapshot: MediaSnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal("negotiation"),
    operationId: z.uuid(),
    sessionVersion: version,
    phase: z.enum(["awaiting_apply", "awaiting_answer"]),
    sessionDescription: MediaDescriptionSchema,
    publications: z.array(MediaPublicationSchema).max(4),
    subscriptions: z.array(MediaSubscriptionSchema).max(60),
    deadline: time,
  }),
  z.strictObject({
    kind: z.literal("completed"),
    operationId: z.uuid(),
    sessionVersion: version,
    revision: version,
    subscriptions: z.array(MediaSubscriptionSchema).max(60).optional(),
  }),
  z.strictObject({
    kind: z.literal("moderated"),
    revision: version,
    cleanupPending: z.boolean(),
  }),
]);
/** Subscribe and answer always return a complete map, including an empty one. */
export const ConsumerMediaOutcomeSchema = MediaOutcomeSchema.refine(
  (result) => result.kind !== "completed" || result.subscriptions !== undefined,
  {
    message: "Consumer completion requires subscriptions",
    path: ["subscriptions"],
  },
);
export type MediaOutcome = z.infer<typeof MediaOutcomeSchema>;
export type AccountMediaOutcome =
  | Extract<MediaOutcome, { kind: "media_status" | "joined" | "left" }>
  | MediaFailure;
