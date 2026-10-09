import { sql, type Kysely } from "kysely";
import {
  ATTACHMENT_OWNER_OUTSTANDING_BYTES,
  ATTACHMENT_OWNER_OUTSTANDING_LIMIT,
  ATTACHMENT_OWNER_STORAGE_BYTES,
  ATTACHMENT_READY_MS,
  ATTACHMENT_RESERVATION_MS,
  ATTACHMENT_UPLOADER_OUTSTANDING_BYTES,
  ATTACHMENT_UPLOADER_OUTSTANDING_LIMIT,
  ATTACHMENT_UPLOAD_MS,
  type AttachmentOutcome,
  type AttachmentIncident,
  type ReserveAttachment,
} from "@vaskel/contracts/attachments";
import { commandWindowFailure } from "@/server/actors/shared/message-command";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import {
  access,
  getState,
  principalFailure,
} from "@/server/actors/shared/policy";
import { sha256Hex } from "@/server/auth/crypto";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { newSendFailure } from "@/server/actors/shared/send-policy";
import { growthCapacityFailure } from "@/server/actors/shared/capacity";
import { descriptor, findAttachment, retireAttachment } from "./state";
import {
  matchesObject,
  type AttachmentUpload,
  type AttachmentUploadResult,
} from "./types";

export async function reserveAttachment(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: ReserveAttachment,
  budgetBytes: number,
): Promise<AttachmentOutcome> {
  const payloadHash = await sha256Hex(
    JSON.stringify({
      commandId: input.commandId,
      issuedAt: input.issuedAt,
      channelId: input.channelId,
      filename: input.filename,
      byteLength: input.byteLength,
    }),
  );
  return storage.transaction(async () => {
    const now = Date.now();
    const authorized = await access(database, principal, input.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const expired = commandWindowFailure(input.issuedAt, now);
    if (expired) return expired;
    const previous = await database
      .selectFrom("attachments")
      .selectAll()
      .where("uploader_id", "=", principal.userId)
      .where("command_id", "=", input.commandId)
      .executeTakeFirst();
    if (previous)
      return previous.payload_hash === payloadHash
        ? {
            kind: "attachment_reserved",
            fileId: previous.id,
            expiresAt: previous.reservation_expires_at,
          }
        : { kind: "command_conflict" };
    const blocked = await newSendFailure(database, authorized.state);
    if (blocked) return blocked;
    const totals = await sql<{
      count: number;
      bytes: number;
      user_count: number;
      user_bytes: number;
    }>`
      SELECT COALESCE(SUM(outstanding), 0) AS count,
        COALESCE(SUM(byte_length * outstanding), 0) AS bytes,
        COALESCE(SUM(CASE WHEN uploader_id = ${principal.userId} THEN outstanding ELSE 0 END), 0) AS user_count,
        COALESCE(SUM(CASE WHEN uploader_id = ${principal.userId} THEN byte_length * outstanding ELSE 0 END), 0) AS user_bytes
      FROM attachments WHERE outstanding = 1`.execute(database);
    const total = totals.rows[0]!;
    if (
      total.count >= ATTACHMENT_OWNER_OUTSTANDING_LIMIT ||
      total.bytes + input.byteLength > ATTACHMENT_OWNER_OUTSTANDING_BYTES ||
      authorized.state.attachment_bytes + input.byteLength >
        ATTACHMENT_OWNER_STORAGE_BYTES ||
      total.user_count >= ATTACHMENT_UPLOADER_OUTSTANDING_LIMIT ||
      total.user_bytes + input.byteLength >
        ATTACHMENT_UPLOADER_OUTSTANDING_BYTES
    )
      return { kind: "capacity" };
    const full = await growthCapacityFailure(storage, database, budgetBytes);
    if (full) return full;
    const fileId = crypto.randomUUID();
    const expiresAt = now + ATTACHMENT_RESERVATION_MS;
    const state = authorized.state;
    await database
      .insertInto("attachments")
      .values({
        id: fileId,
        channel_id: input.channelId,
        uploader_id: principal.userId,
        command_id: input.commandId,
        payload_hash: payloadHash,
        issued_at: input.issuedAt,
        created_at: now,
        reservation_expires_at: expiresAt,
        filename: input.filename,
        byte_length: input.byteLength,
        object_key: `attachments/${state.owner_kind}/${state.owner_id}/${fileId}`,
        owner_generation: state.generation,
        state: "reserved",
        deadline: expiresAt,
      })
      .execute();
    await database
      .updateTable("owner_state")
      .set({ attachment_bytes: state.attachment_bytes + input.byteLength })
      .where("id", "=", 1)
      .execute();
    await scheduleAlarm(storage, expiresAt);
    return { kind: "attachment_reserved", fileId, expiresAt };
  });
}

export async function beginAttachmentUpload(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  fileId: string,
): Promise<
  AttachmentOutcome | { kind: "attachment_upload"; upload: AttachmentUpload }
> {
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const row = await findAttachment(database, fileId);
    if (!row || row.uploader_id !== principal.userId)
      return { kind: "not_found" };
    const authorized = await access(database, principal, row.channel_id);
    if (authorized.kind !== "authorized") return authorized;
    if (row.state === "claimed" && row.message_id)
      return { kind: "attachment_claimed", messageId: row.message_id };
    const blocked = await newSendFailure(database, authorized.state);
    if (blocked) return blocked;
    if (row.state === "retired" || row.state === "cleaned")
      return { kind: "attachment_expired" };
    if (
      row.deadline === null ||
      row.deadline <= Date.now() ||
      row.owner_generation !== authorized.state.generation
    ) {
      await retireAttachment(storage, database, row);
      return { kind: "attachment_expired" };
    }
    if (row.quarantined) return { kind: "attachment_not_ready" };
    if (row.state === "uploading") return { kind: "upload_in_progress" };
    if (row.state !== "reserved" || !row.object_key)
      return { kind: "attachment_not_ready" };
    const expiresAt = Date.now() + ATTACHMENT_UPLOAD_MS;
    await database
      .updateTable("attachments")
      .set({
        state: "uploading",
        deadline: expiresAt,
        writer_state: "unresolved",
      })
      .where("id", "=", fileId)
      .execute();
    await scheduleAlarm(storage, expiresAt);
    return {
      kind: "attachment_upload",
      upload: {
        fileId,
        objectKey: row.object_key,
        generation: row.owner_generation,
        byteLength: row.byte_length,
        expiresAt,
      },
    };
  });
}

/** Trusted result reporting must run even when the refreshed D1 session has disappeared. */
export async function completeAttachmentUpload(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal | null,
  upload: AttachmentUpload,
  result: AttachmentUploadResult,
): Promise<AttachmentOutcome> {
  return storage.transaction(async () => {
    const row = await findAttachment(database, upload.fileId);
    if (
      !row ||
      row.owner_generation !== upload.generation ||
      row.object_key !== upload.objectKey ||
      row.byte_length !== upload.byteLength
    )
      return { kind: "attachment_expired" };
    // A settled writer result cannot invalidate a claimed file or reopen a retired key.
    const matching =
      result.kind === "stored" && matchesObject(row, result.object);
    if (result.kind === "stored" && !matching) {
      if (row.state !== "claimed")
        await retireAttachment(storage, database, row);
      await database
        .updateTable("attachments")
        .set({ cleanup_error: "object_identity_mismatch" })
        .where("id", "=", row.id)
        .execute();
      return { kind: "integrity_mismatch" };
    }
    if (matching && result.kind === "stored")
      await database
        .updateTable("attachments")
        .set({
          writer_state: "settled",
          object_version: result.object.version,
          object_etag: result.object.etag,
        })
        .where("id", "=", row.id)
        .execute();
    else if (
      result.kind === "not_started" &&
      (row.state === "uploading" || row.state === "retired") &&
      row.writer_state === "unresolved" &&
      row.object_version === null
    )
      await database
        .updateTable("attachments")
        .set({ writer_state: "never_started" })
        .where("id", "=", row.id)
        .execute();
    if (row.state === "retired" || row.state === "cleaned") {
      // Do not clear/replace another cleanup claim. Its result is fenced by its lease.
      if (row.state === "retired" && !row.preservation_hold) {
        // Claimed files keep outstanding=0 after detachment. Only an unclaimed
        // writer can accelerate cleanup; sent files retain their deletion grace.
        const cleanupAt = row.outstanding
          ? Date.now()
          : Math.max(Date.now(), row.cleanup_at ?? 0);
        await database
          .updateTable("attachments")
          .set({ cleanup_at: cleanupAt })
          .where("id", "=", row.id)
          .execute();
        await scheduleAlarm(storage, cleanupAt);
      }
      return { kind: "attachment_expired" };
    }
    // A timeout reporting uncertainty after a successful completion cannot retire ready content.
    if (
      result.kind !== "stored" &&
      (row.state === "ready" || row.state === "claimed")
    )
      return { kind: "attachment_not_ready" };
    const authorized =
      principal && principal.userId === row.uploader_id
        ? await access(database, principal, row.channel_id)
        : { kind: "unauthenticated" as const };
    if (row.state === "claimed" && row.message_id)
      return authorized.kind === "authorized"
        ? { kind: "attachment_claimed", messageId: row.message_id }
        : authorized;
    if (authorized.kind !== "authorized") {
      await retireAttachment(storage, database, row);
      return authorized;
    }
    const blocked = await newSendFailure(database, authorized.state);
    if (blocked) {
      await retireAttachment(storage, database, row);
      return blocked;
    }
    if (
      row.deadline === null ||
      row.deadline <= Date.now() ||
      authorized.state.generation !== row.owner_generation
    ) {
      await retireAttachment(storage, database, row);
      return { kind: "attachment_expired" };
    }
    if (row.quarantined || !matching) {
      await retireAttachment(storage, database, row);
      return {
        kind: row.quarantined ? "attachment_not_ready" : "integrity_mismatch",
      };
    }
    if (row.state === "ready")
      return {
        kind: "attachment_ready",
        attachment: descriptor(row),
        expiresAt: row.deadline,
      };
    if (row.state !== "uploading") return { kind: "attachment_not_ready" };
    const expiresAt = Date.now() + ATTACHMENT_READY_MS;
    await database
      .updateTable("attachments")
      .set({
        state: "ready",
        deadline: expiresAt,
      })
      .where("id", "=", row.id)
      .execute();
    await scheduleAlarm(storage, expiresAt);
    return {
      kind: "attachment_ready",
      attachment: descriptor(row),
      expiresAt,
    };
  });
}

export async function attachmentStatus(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  fileId: string,
): Promise<AttachmentOutcome> {
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const row = await findAttachment(database, fileId);
    if (!row || row.uploader_id !== principal.userId)
      return { kind: "not_found" };
    const authorized = await access(database, principal, row.channel_id);
    if (authorized.kind !== "authorized") return authorized;
    if (row.quarantined || row.state === "retired" || row.state === "cleaned")
      return { kind: "attachment_status", state: "unavailable" };
    if (row.state === "claimed" && row.message_id) {
      const message = await database
        .selectFrom("messages")
        .select("deleted_at")
        .where("id", "=", row.message_id)
        .executeTakeFirst();
      return message?.deleted_at === null
        ? {
            kind: "attachment_status",
            state: "claimed",
            messageId: row.message_id,
          }
        : { kind: "attachment_status", state: "unavailable" };
    }
    if (
      row.deadline === null ||
      row.deadline <= Date.now() ||
      row.owner_generation !== authorized.state.generation
    ) {
      await retireAttachment(storage, database, row);
      return { kind: "attachment_status", state: "unavailable" };
    }
    if (row.state === "ready")
      return {
        kind: "attachment_status",
        state: "ready",
        attachment: descriptor(row),
        expiresAt: row.deadline,
      };
    if (row.state === "reserved" || row.state === "uploading")
      return {
        kind: "attachment_status",
        state: row.state,
        expiresAt: row.deadline,
      };
    return { kind: "attachment_status", state: "unavailable" };
  });
}

export async function cancelAttachment(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  fileId: string,
): Promise<AttachmentOutcome> {
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const row = await findAttachment(database, fileId);
    if (!row || row.uploader_id !== principal.userId)
      return { kind: "not_found" };
    if (row.state === "claimed" && row.message_id)
      return { kind: "attachment_claimed", messageId: row.message_id };
    await retireAttachment(storage, database, row);
    return { kind: "attachment_canceled" };
  });
}

export async function setAttachmentIncident(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  operator: Principal & { isOperator: true },
  fileId: string,
  input: AttachmentIncident,
): Promise<AttachmentOutcome> {
  return storage.transaction(async () => {
    const invalid = principalFailure(operator);
    if (invalid) return invalid;
    const state = await getState(database);
    const row = await findAttachment(database, fileId);
    if (!state || !row || !operator.isOperator) return { kind: "not_found" };
    if (input.preserve && (row.deletion_authorized || row.state === "cleaned"))
      return { kind: "attachment_expired" };
    await database
      .updateTable("attachments")
      .set({
        quarantined: Number(input.quarantined),
        preservation_hold: Number(input.preserve),
      })
      .where("id", "=", row.id)
      .execute();
    await database
      .insertInto("attachment_incidents")
      .values({
        id: crypto.randomUUID(),
        file_id: row.id,
        operator_id: operator.userId,
        quarantined: Number(input.quarantined),
        preservation_hold: Number(input.preserve),
        incident_reference: input.incidentReference,
        recorded_at: Date.now(),
      })
      .execute();
    if (!input.preserve && row.cleanup_at !== null)
      await scheduleAlarm(storage, row.cleanup_at);
    return { kind: "attachment_updated" };
  });
}
