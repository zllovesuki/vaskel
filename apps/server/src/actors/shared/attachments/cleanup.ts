import { sql, type Kysely } from "kysely";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { RECEIPT_RETENTION_MS } from "@/server/actors/shared/retention";
import { actorWork } from "@/server/actors/shared/bounded-work";
import { findAttachment, retireAttachment } from "./state";
import { matchesObject, storageObservation, type AttachmentRow } from "./types";

export const ATTACHMENT_CLEANUP_BATCH = 20;
export const ATTACHMENT_CLEANUP_BUDGET_MS = 5_000;
const CLEANUP_LEASE_MS = 30_000;
const UNCERTAIN_PROBE_MS = 60 * 60_000;
type Bucket = Pick<R2Bucket, "head" | "delete">;

/** The retired -> cleaned transaction releases the row's storage liability once. */
async function cleanRow(database: Kysely<OwnerDatabase>, row: AttachmentRow) {
  const released = await database
    .updateTable("owner_state")
    .set({ attachment_bytes: sql`attachment_bytes - ${row.byte_length}` })
    .where("id", "=", 1)
    .where("attachment_bytes", ">=", row.byte_length)
    .executeTakeFirst();
  if (released.numUpdatedRows !== 1n)
    throw new Error("Attachment storage charge invariant failed");
  // The original reservation receipt remains recoverable without retaining file material.
  await database
    .updateTable("attachments")
    .set({
      state: "cleaned",
      deadline: null,
      filename: null,
      object_key: null,
      object_version: null,
      object_etag: null,
      outstanding: 0,
      cleanup_lease: null,
      cleanup_lease_expires_at: null,
      cleanup_at: row.created_at + RECEIPT_RETENTION_MS,
      cleanup_error: null,
    })
    .where("id", "=", row.id)
    .execute();
}

/** Each external await has a persistent claim and a recovery alarm before it begins. */
export async function drainAttachments(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  bucket: Bucket,
) {
  const budgetEnd = Date.now() + ATTACHMENT_CLEANUP_BUDGET_MS;
  for (
    let count = 0;
    count < ATTACHMENT_CLEANUP_BATCH && Date.now() < budgetEnd;
    count++
  ) {
    const claim = await ctx.storage.transaction(async () => {
      const now = Date.now();
      const expired = await database
        .selectFrom("attachments")
        .selectAll()
        .where("deadline", "<=", now)
        .orderBy("deadline")
        .limit(1)
        .executeTakeFirst();
      if (expired) {
        await retireAttachment(ctx.storage, database, expired);
        return { kind: "local" as const };
      }
      const row = await database
        .selectFrom("attachments")
        .selectAll()
        .where("cleanup_at", "<=", now)
        .where("preservation_hold", "=", 0)
        .where((expression) =>
          expression.or([
            expression("cleanup_lease_expires_at", "is", null),
            expression("cleanup_lease_expires_at", "<=", now),
          ]),
        )
        .orderBy("cleanup_at")
        .limit(1)
        .executeTakeFirst();
      if (!row) return null;
      if (row.state === "cleaned") {
        await database
          .deleteFrom("attachments")
          .where("id", "=", row.id)
          .execute();
        return { kind: "local" as const };
      }
      if (row.state !== "retired")
        throw new Error("Cleanup selected a live file");
      if (row.message_id) {
        const message = await database
          .selectFrom("messages")
          .select("deleted_at")
          .where("id", "=", row.message_id)
          .executeTakeFirst();
        if (message?.deleted_at === null)
          throw new Error("Cleanup selected a live reference");
      }
      if (row.writer_state === "never_started") {
        await cleanRow(database, row);
        await scheduleAlarm(ctx.storage, row.created_at + RECEIPT_RETENTION_MS);
        return { kind: "local" as const };
      }
      if (!row.object_key)
        throw new Error("Unresolved attachment lost its key");
      const lease = crypto.randomUUID();
      const deleting = row.writer_state === "settled";
      await database
        .updateTable("attachments")
        .set({
          cleanup_lease: lease,
          cleanup_lease_expires_at: now + CLEANUP_LEASE_MS,
          cleanup_attempts: row.cleanup_attempts + 1,
          deletion_authorized: deleting ? 1 : row.deletion_authorized,
        })
        .where("id", "=", row.id)
        .execute();
      await scheduleAlarm(ctx.storage, now + CLEANUP_LEASE_MS);
      return { kind: "external" as const, row, lease, deleting };
    });
    if (!claim) break;
    if (claim.kind === "local") continue;
    const retryStorageFailure = async () => {
      await ctx.storage.transaction(async () => {
        const current = await findAttachment(database, claim.row.id);
        if (!current || current.cleanup_lease !== claim.lease) return;
        const nextAt =
          Date.now() +
          Math.min(
            UNCERTAIN_PROBE_MS,
            1_000 * 2 ** Math.min(current.cleanup_attempts, 12),
          );
        await database
          .updateTable("attachments")
          .set({
            cleanup_lease: null,
            cleanup_lease_expires_at: null,
            cleanup_at: nextAt,
            cleanup_error: "storage_unavailable",
          })
          .where("id", "=", current.id)
          .execute();
        if (!current.preservation_hold)
          await scheduleAlarm(ctx.storage, nextAt);
      });
    };
    const completed = await actorWork(ctx.storage, "maintenance").run(
      async () => {
        if (claim.deleting) {
          const deleted = await bucket.delete(claim.row.object_key!).then(
            () => true,
            () => false,
          );
          if (!deleted) {
            await retryStorageFailure();
            return;
          }
          await ctx.storage.transaction(async () => {
            const current = await findAttachment(database, claim.row.id);
            if (!current || current.cleanup_lease !== claim.lease) return;
            if (
              current.state !== "retired" ||
              current.writer_state !== "settled" ||
              !current.deletion_authorized
            )
              throw new Error("Attachment deletion lost its fence");
            await cleanRow(database, current);
            await scheduleAlarm(
              ctx.storage,
              current.created_at + RECEIPT_RETENTION_MS,
            );
          });
        } else {
          const opened = await bucket.head(claim.row.object_key!).then(
            (object) => ({ ok: true as const, object }),
            () => ({ ok: false as const }),
          );
          if (!opened.ok) {
            await retryStorageFailure();
            return;
          }
          const object = opened.object;
          await ctx.storage.transaction(async () => {
            const current = await findAttachment(database, claim.row.id);
            if (
              !current ||
              current.cleanup_lease !== claim.lease ||
              current.state !== "retired"
            )
              return;
            const matches =
              object !== null &&
              matchesObject(current, storageObservation(object));
            // Absence is not settlement. Record a discovered writer before a later DELETE.
            const nextAt =
              Date.now() +
              (matches || current.writer_state !== "unresolved"
                ? 1
                : UNCERTAIN_PROBE_MS);
            await database
              .updateTable("attachments")
              .set({
                ...(matches
                  ? {
                      writer_state: "settled" as const,
                      object_version: object.version,
                      object_etag: object.etag,
                    }
                  : {}),
                cleanup_lease: null,
                cleanup_lease_expires_at: null,
                cleanup_at: nextAt,
                cleanup_error:
                  object && !matches ? "object_identity_mismatch" : null,
              })
              .where("id", "=", current.id)
              .execute();
            if (!current.preservation_hold)
              await scheduleAlarm(ctx.storage, nextAt);
          });
        }
      },
      budgetEnd,
      `attachment:${claim.row.id}`,
      ATTACHMENT_CLEANUP_BUDGET_MS,
    );
    if (!completed.ok) {
      // A late callback can only finish its own lease; recovery may already have replaced it.
      // Its actor-wide slot stays occupied until settlement, even across later alarms.
      break;
    }
  }
}
