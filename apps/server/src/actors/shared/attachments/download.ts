import type { Kysely } from "kysely";
import type { AttachmentFailure } from "@vaskel/contracts/attachments";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { access, principalFailure } from "@/server/actors/shared/policy";
import { findAttachment } from "./state";
import {
  matchesObject,
  type AttachmentDownload,
  type StoredAttachment,
} from "./types";

export async function authorizeAttachmentDownload(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  fileId: string,
  observed?: StoredAttachment,
): Promise<
  | AttachmentFailure
  | { kind: "attachment_download"; download: AttachmentDownload }
> {
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const row = await findAttachment(database, fileId);
    if (
      !row ||
      row.state !== "claimed" ||
      row.quarantined ||
      !row.message_id ||
      !row.object_key ||
      !row.filename ||
      !row.object_version ||
      !row.object_etag
    )
      return { kind: "not_found" };
    const authorized = await access(database, principal, row.channel_id);
    if (authorized.kind !== "authorized") return authorized;
    const message = await database
      .selectFrom("messages")
      .select(["deleted_at", "channel_id"])
      .where("id", "=", row.message_id)
      .executeTakeFirst();
    if (
      !message ||
      message.deleted_at !== null ||
      message.channel_id !== row.channel_id ||
      row.owner_generation !== authorized.state.generation
    )
      return { kind: "not_found" };
    if (observed && !matchesObject(row, observed))
      return { kind: "integrity_mismatch" };
    return {
      kind: "attachment_download",
      download: {
        fileId: row.id,
        objectKey: row.object_key,
        generation: row.owner_generation,
        version: row.object_version,
        etag: row.object_etag,
        byteLength: row.byte_length,
        filename: row.filename,
        messageId: row.message_id,
      },
    };
  });
}
