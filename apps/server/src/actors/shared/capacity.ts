import { pruneOwnerRetention, ownerRetentionWake } from "./retention";
import { scheduleAlarm } from "./alarms";
import { ATTACHMENT_OWNER_STORAGE_BYTES } from "@vaskel/contracts/attachments";
import { sql, type Kysely } from "kysely";
import {
  OWNER_SQL_DEFAULT_BUDGET_BYTES,
  OWNER_SQL_MAX_BUDGET_BYTES,
  OWNER_SQL_MIN_BUDGET_BYTES,
  type OwnerCapacity,
  type OwnerCapacityOutcome,
  type StorageCapacityFailure,
} from "@vaskel/contracts/capacity";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { getState, membership, principalFailure } from "./policy";

export function ownerSqlBudgetBytes(config?: string): number {
  if (config === undefined) return OWNER_SQL_DEFAULT_BUDGET_BYTES;
  const value = /^\d+$/.test(config) ? Number(config) : NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < OWNER_SQL_MIN_BUDGET_BYTES ||
    value > OWNER_SQL_MAX_BUDGET_BYTES
  )
    throw new Error(
      "OWNER_SQL_BUDGET_BYTES must be an integer from 8 MiB to 8 GiB.",
    );
  return value;
}

function sqlCapacity(
  storage: DurableObjectStorage,
  budgetBytes: number,
): OwnerCapacity["sql"] {
  const usedBytes = storage.sql.databaseSize;
  const warningBytes = Math.ceil(budgetBytes * 0.7);
  const pauseBytes = Math.ceil(budgetBytes * 0.85);
  return {
    usedBytes,
    budgetBytes,
    warningBytes,
    pauseBytes,
    status:
      usedBytes >= pauseBytes
        ? "paused"
        : usedBytes >= warningBytes
          ? "warning"
          : "normal",
  };
}

/**
 * Call inside the owning native transaction after authority, time, receipt and
 * recovery checks, immediately before new growth. Pressure first reclaims bounded
 * expired receipts and remeasures native used pages. The measurement admits
 * one whole command: that command can cross the threshold. The reserve is also
 * consumed by deletion/receipts, permission/read/incident changes, admitted
 * upload completion and cleanup. It is headroom, not a hard storage guarantee.
 */
export async function growthCapacityFailure(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  budgetBytes: number,
): Promise<StorageCapacityFailure | undefined> {
  if (sqlCapacity(storage, budgetBytes).status !== "paused") return undefined;
  const now = Date.now();
  await pruneOwnerRetention(database, now);
  const wake = await ownerRetentionWake(database, now);
  if (wake !== null) await scheduleAlarm(storage, wake);
  return sqlCapacity(storage, budgetBytes).status === "paused"
    ? { kind: "storage_capacity" }
    : undefined;
}

/** Explicit, aggregate-only inspection; never used for ordinary navigation. */
export async function ownerCapacity(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  principal: Principal & { isOperator?: true },
  budgetBytes: number,
): Promise<OwnerCapacityOutcome> {
  return ctx.storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const state = await getState(database);
    if (!state) return { kind: "not_found" };
    if (state.owner_kind === "server") {
      if ((await membership(database, principal.userId))?.role !== "owner")
        return { kind: "forbidden" };
    } else if (principal.isOperator !== true) return { kind: "forbidden" };

    const files = (
      await sql<{
        live: number;
        retired: number;
        held: number;
        outstanding: number;
        uploads: number;
        oldest_upload: number | null;
        cleanup: number;
        oldest_cleanup: number | null;
      }>`SELECT
      COALESCE(SUM(CASE WHEN state NOT IN ('retired', 'cleaned') THEN byte_length ELSE 0 END), 0) AS live,
      COALESCE(SUM(CASE WHEN state = 'retired' THEN byte_length ELSE 0 END), 0) AS retired,
      COALESCE(SUM(CASE WHEN state != 'cleaned' AND preservation_hold = 1 THEN byte_length ELSE 0 END), 0) AS held,
      COALESCE(SUM(CASE WHEN outstanding = 1 THEN byte_length ELSE 0 END), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN outstanding = 1 THEN 1 ELSE 0 END), 0) AS uploads,
      MIN(CASE WHEN outstanding = 1 THEN created_at ELSE NULL END) AS oldest_upload,
      COALESCE(SUM(CASE WHEN state = 'retired' THEN 1 ELSE 0 END), 0) AS cleanup,
      MIN(CASE WHEN state = 'retired' THEN cleanup_at ELSE NULL END) AS oldest_cleanup
      FROM attachments`.execute(database)
    ).rows[0]!;
    const deleted = (
      await sql<{ count: number; oldest: number | null }>`
      SELECT COUNT(*) AS count, MIN(eligible_at) AS oldest FROM deleted_payloads
    `.execute(database)
    ).rows[0]!;
    const media = (
      await sql<{ count: number; oldest: number | null }>`
      SELECT COUNT(*) AS count, MIN(next_attempt_at) AS oldest FROM media_invalidations
    `.execute(database)
    ).rows[0]!;
    const tickets = await database
      .selectFrom("socket_tickets")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("expires_at", ">", Date.now())
      .executeTakeFirstOrThrow();
    return {
      kind: "owner_capacity",
      sql: sqlCapacity(ctx.storage, budgetBytes),
      attachments: {
        chargedBytes: state.attachment_bytes,
        liveBytes: files.live,
        retiredBytes: files.retired,
        heldBytes: files.held,
        outstandingBytes: files.outstanding,
      },
      sockets: {
        tickets: tickets.count,
        active: ctx
          .getWebSockets()
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
      },
      cleanup: {
        deletedPayloads: {
          count: deleted.count,
          oldestEligibleAt: deleted.oldest,
        },
        uploads: { count: files.uploads, oldestCreatedAt: files.oldest_upload },
        attachments: {
          count: files.cleanup,
          oldestDueAt: files.oldest_cleanup,
        },
        mediaInvalidations: { count: media.count, oldestDueAt: media.oldest },
      },
    };
  });
}

/** Operator-only aggregate surface; deliberately contains no participant/content metadata. */
export async function operatorOwnerUsage(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  principal: Principal & { isOperator: true },
  budgetBytes: number,
): Promise<import("@vaskel/contracts/instance").OwnerUsageOutcome> {
  return ctx.storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    if (principal.isOperator !== true) return { kind: "forbidden" };
    const state = await getState(database);
    if (!state) return { kind: "not_found" };
    return {
      kind: "owner_usage",
      sql: sqlCapacity(ctx.storage, budgetBytes),
      attachments: {
        chargedBytes: state.attachment_bytes,
        budgetBytes: ATTACHMENT_OWNER_STORAGE_BYTES,
      },
    };
  });
}
