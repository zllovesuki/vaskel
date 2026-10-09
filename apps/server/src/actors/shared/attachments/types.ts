import type { Generated, Selectable } from "kysely";

export interface AttachmentTable {
  id: string;
  channel_id: string;
  uploader_id: string;
  command_id: string;
  payload_hash: string;
  issued_at: number;
  created_at: number;
  reservation_expires_at: number;
  filename: string | null;
  byte_length: number;
  object_key: string | null;
  owner_generation: string;
  state: "reserved" | "uploading" | "ready" | "claimed" | "retired" | "cleaned";
  deadline: number | null;
  object_version: Generated<string | null>;
  object_etag: Generated<string | null>;
  writer_state: Generated<"never_started" | "unresolved" | "settled">;
  message_id: Generated<string | null>;
  ordinal: Generated<number | null>;
  outstanding: Generated<number>;
  quarantined: Generated<number>;
  preservation_hold: Generated<number>;
  cleanup_at: Generated<number | null>;
  cleanup_attempts: Generated<number>;
  cleanup_lease: Generated<string | null>;
  cleanup_lease_expires_at: Generated<number | null>;
  deletion_authorized: Generated<number>;
  cleanup_error: Generated<string | null>;
}
export type AttachmentRow = Selectable<AttachmentTable>;

/** Private one-shot write admission, returned only by trusted Worker-to-owner RPC. */
export interface AttachmentUpload {
  fileId: string;
  objectKey: string;
  generation: string;
  byteLength: number;
  expiresAt: number;
}
export interface StoredAttachment {
  key: string;
  version: string;
  etag: string;
  size: number;
  fileId: string | undefined;
  generation: string | undefined;
}
export type AttachmentUploadResult =
  | {
      kind: "stored";
      object: StoredAttachment;
    }
  | { kind: "not_started" }
  | { kind: "uncertain" };
export interface AttachmentDownload {
  fileId: string;
  objectKey: string;
  generation: string;
  version: string;
  etag: string;
  byteLength: number;
  filename: string;
  messageId: string;
}
export function storageObservation(object: R2Object): StoredAttachment {
  return {
    key: object.key,
    version: object.version,
    etag: object.etag,
    size: object.size,
    fileId: object.customMetadata?.fileId,
    generation: object.customMetadata?.generation,
  };
}
export function matchesObject(
  row: AttachmentRow,
  object: StoredAttachment,
): boolean {
  return (
    row.object_key === object.key &&
    row.id === object.fileId &&
    row.owner_generation === object.generation &&
    row.byte_length === object.size &&
    (row.object_version === null || row.object_version === object.version) &&
    (row.object_etag === null || row.object_etag === object.etag)
  );
}
