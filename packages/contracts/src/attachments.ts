import { z } from "zod";
import { StorageCapacityFailureSchema } from "./capacity";

export const ATTACHMENT_BYTE_LIMIT = 10 * 1_024 * 1_024;
export const MESSAGE_ATTACHMENT_LIMIT = 4;
export const ATTACHMENT_RESERVATION_MS = 5 * 60_000;
export const ATTACHMENT_UPLOAD_MS = 5 * 60_000;
export const ATTACHMENT_READY_MS = 60 * 60_000;
export const ATTACHMENT_UPLOADER_OUTSTANDING_LIMIT = 8;
export const ATTACHMENT_UPLOADER_OUTSTANDING_BYTES = 80 * 1_024 * 1_024;
export const ATTACHMENT_OWNER_OUTSTANDING_LIMIT = 128;
export const ATTACHMENT_OWNER_OUTSTANDING_BYTES = 1_024 ** 3;
export const ATTACHMENT_OWNER_STORAGE_BYTES = 10 * 1_024 ** 3;

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative();
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
export const AttachmentFilenameSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !/[\0\r\n]/u.test(value) &&
      new TextEncoder().encode(value).byteLength <= 1_024 &&
      Array.from(graphemes.segment(value)).length <= 255,
    "Filename must be nonblank, at most 255 graphemes / 1 KiB, without NUL or line breaks.",
  );
export const AttachmentDescriptorSchema = z.strictObject({
  fileId: z.uuid(),
  filename: AttachmentFilenameSchema,
  byteLength: z.number().int().min(1).max(ATTACHMENT_BYTE_LIMIT),
});
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;
export const AttachmentGrantSchema = z.strictObject({
  url: z.string().startsWith("/api/files/"),
  expiresAt: timestamp,
});
export type AttachmentGrant = z.infer<typeof AttachmentGrantSchema>;

export const INLINE_SIGNATURE_BYTES = 64;
export type InlineContentType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm";

/**
 * A bounded type admission from leading bytes: neither a decoder, a malware
 * verdict nor trust in a filename or declared MIME type. Only these types are
 * ever served inline; everything else stays a download.
 */
export function detectInlineContentType(
  bytes: Uint8Array,
): InlineContentType | null {
  const matches = (offset: number, value: readonly number[]) =>
    value.every((byte, index) => bytes[offset + index] === byte);
  if (
    bytes.length >= 24 &&
    matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    matches(8, [0, 0, 0, 13, 73, 72, 68, 82])
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    matches(0, [255, 216, 255]) &&
    bytes[3] !== 0 &&
    bytes[3] !== 255
  )
    return "image/jpeg";
  if (
    bytes.length >= 10 &&
    (matches(0, [71, 73, 70, 56, 55, 97]) ||
      matches(0, [71, 73, 70, 56, 57, 97]))
  )
    return "image/gif";
  if (
    bytes.length >= 16 &&
    matches(0, [82, 73, 70, 70]) &&
    matches(8, [87, 69, 66, 80]) &&
    (matches(12, [86, 80, 56, 32]) ||
      matches(12, [86, 80, 56, 76]) ||
      matches(12, [86, 80, 56, 88]))
  )
    return "image/webp";
  // ISO base media: "ftyp" follows the box size, then the major brand.
  if (bytes.length >= 12 && matches(4, [102, 116, 121, 112]))
    return matches(8, [113, 116, 32, 32]) ? "video/quicktime" : "video/mp4";
  // An EBML header whose DocType element reads "webm" within the window; Matroska is not admitted.
  if (bytes.length >= 8 && matches(0, [26, 69, 223, 163])) {
    const last = Math.min(bytes.length, INLINE_SIGNATURE_BYTES) - 7;
    for (let offset = 4; offset <= last; offset++)
      if (matches(offset, [66, 130, 132, 119, 101, 98, 109]))
        return "video/webm";
  }
  return null;
}
export const AttachmentIdsSchema = z
  .array(z.uuid())
  .max(MESSAGE_ATTACHMENT_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length);
export const ReserveAttachmentSchema = z.strictObject({
  commandId: identifier,
  issuedAt: timestamp,
  channelId: identifier,
  filename: AttachmentFilenameSchema,
  byteLength: AttachmentDescriptorSchema.shape.byteLength,
});
export type ReserveAttachment = z.infer<typeof ReserveAttachmentSchema>;
export const AttachmentClaimedSchema = z.strictObject({
  kind: z.literal("attachment_claimed"),
  messageId: identifier,
});
export const AttachmentStateFailureSchema = z.union([
  z.strictObject({
    kind: z.enum([
      "attachment_not_ready",
      "attachment_expired",
      "upload_in_progress",
      "integrity_mismatch",
    ]),
  }),
  AttachmentClaimedSchema,
]);
export const AttachmentFailureSchema = z.union([
  StorageCapacityFailureSchema,
  z.strictObject({
    kind: z.enum([
      "invalid_input",
      "unauthenticated",
      "forbidden",
      "dm_blocked",
      "not_found",
      "command_conflict",
      "command_expired",
      "capacity",
    ]),
  }),
  AttachmentStateFailureSchema,
]);
export type AttachmentFailure = z.infer<typeof AttachmentFailureSchema>;
export const AttachmentStatusSchema = z.union([
  z.strictObject({
    kind: z.literal("attachment_status"),
    state: z.enum(["reserved", "uploading"]),
    expiresAt: timestamp,
  }),
  z.strictObject({
    kind: z.literal("attachment_status"),
    state: z.literal("ready"),
    attachment: AttachmentDescriptorSchema,
    expiresAt: timestamp,
  }),
  z.strictObject({
    kind: z.literal("attachment_status"),
    state: z.literal("claimed"),
    messageId: identifier,
  }),
  z.strictObject({
    kind: z.literal("attachment_status"),
    state: z.literal("unavailable"),
  }),
]);
export const AttachmentOutcomeSchema = z.union([
  AttachmentFailureSchema,
  z.strictObject({
    kind: z.literal("attachment_reserved"),
    fileId: z.uuid(),
    expiresAt: timestamp,
  }),
  z.strictObject({
    kind: z.literal("attachment_ready"),
    attachment: AttachmentDescriptorSchema,
    expiresAt: timestamp,
  }),
  z.strictObject({ kind: z.literal("attachment_canceled") }),
  z.strictObject({ kind: z.literal("attachment_updated") }),
  AttachmentStatusSchema,
]);
export type AttachmentOutcome = z.infer<typeof AttachmentOutcomeSchema>;

/** Restricted operator action; no content is returned through this endpoint. */
export const AttachmentIncidentSchema = z.strictObject({
  quarantined: z.boolean(),
  preserve: z.boolean(),
  incidentReference: z.string().trim().min(1).max(200),
});
export type AttachmentIncident = z.infer<typeof AttachmentIncidentSchema>;
