import type { Kysely } from "kysely";
import type {
  AttachmentDescriptor,
  AttachmentFailure,
} from "@vaskel/contracts/attachments";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import type { AttachmentRow } from "./types";

export function descriptor(
  row: Pick<AttachmentRow, "id" | "filename" | "byte_length">,
): AttachmentDescriptor {
  if (row.filename === null)
    throw new Error("Live attachment lost its filename");
  return {
    fileId: row.id,
    filename: row.filename,
    byteLength: row.byte_length,
  };
}
export async function findAttachment(
  database: Kysely<OwnerDatabase>,
  fileId: string,
) {
  return database
    .selectFrom("attachments")
    .selectAll()
    .where("id", "=", fileId)
    .executeTakeFirst();
}

/** Called only inside the owner's native transaction. Retirement cannot be undone. */
export async function retireAttachment(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  row: AttachmentRow,
  eligibleAt = Date.now(),
) {
  if (row.state === "retired" || row.state === "cleaned") return;
  await database
    .updateTable("attachments")
    .set({
      state: "retired",
      deadline: null,
      cleanup_at: eligibleAt,
    })
    .where("id", "=", row.id)
    .execute();
  if (!row.preservation_hold) await scheduleAlarm(storage, eligibleAt);
}

/** Validate the whole set before the first message or claim mutation. */
export async function attachmentsForSend(
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  channelId: string,
  generation: string,
  fileIds: readonly string[],
  now: number,
): Promise<AttachmentRow[] | AttachmentFailure> {
  const rows: AttachmentRow[] = [];
  if (fileIds.length > 4 || new Set(fileIds).size !== fileIds.length)
    return { kind: "invalid_input" };
  for (const id of fileIds) {
    const row = await findAttachment(database, id);
    if (
      !row ||
      row.uploader_id !== principal.userId ||
      row.channel_id !== channelId ||
      row.owner_generation !== generation
    )
      return { kind: "attachment_not_ready" };
    if (row.state === "claimed" && row.message_id)
      return { kind: "attachment_claimed", messageId: row.message_id };
    if (
      row.state === "retired" ||
      row.state === "cleaned" ||
      (row.deadline !== null && row.deadline <= now)
    )
      return { kind: "attachment_expired" };
    if (row.state !== "ready" || row.quarantined)
      return { kind: "attachment_not_ready" };
    rows.push(row);
  }
  return rows;
}
export async function claimAttachments(
  database: Kysely<OwnerDatabase>,
  rows: readonly AttachmentRow[],
  messageId: string,
) {
  for (const [ordinal, row] of rows.entries()) {
    const changed = await database
      .updateTable("attachments")
      .set({
        state: "claimed",
        message_id: messageId,
        ordinal,
        deadline: null,
        outstanding: 0,
      })
      .where("id", "=", row.id)
      .where("state", "=", "ready")
      .executeTakeFirst();
    if (changed.numUpdatedRows !== 1n)
      throw new Error("Attachment claim invariant failed");
  }
}
