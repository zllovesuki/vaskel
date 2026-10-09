import { sql, type Kysely } from "kysely";
import type { OwnerDatabase } from "./database";

export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const AUTHORIZATION_RETENTION_MS = 35 * 24 * 60 * 60_000;
const GC_BUCKET_MS = 60 * 60_000;
const policies = [
  {
    table: "command_receipts",
    timestamp: "accepted_at",
    retention: RECEIPT_RETENTION_MS,
  },
  {
    table: "block_receipts",
    timestamp: "accepted_at",
    retention: RECEIPT_RETENTION_MS,
  },
  {
    table: "registration_authorizations",
    timestamp: "created_at",
    retention: AUTHORIZATION_RETENTION_MS,
  },
] as const;

/** Physical reclamation only; validity checks retain their original deadlines. */
export function retentionWake(timestamp: number, retention: number) {
  return Math.ceil((timestamp + retention) / GC_BUCKET_MS) * GC_BUCKET_MS;
}

/** Caller holds the native transaction. Each indexed table gets its own quota. */
export async function pruneOwnerRetention(
  database: Kysely<OwnerDatabase>,
  now: number,
) {
  for (const { table, timestamp, retention } of policies) {
    await sql`DELETE FROM ${sql.table(table)} WHERE rowid IN (
      SELECT rowid FROM ${sql.table(table)} WHERE ${sql.ref(timestamp)} <= ${now - retention}
      ORDER BY ${sql.ref(timestamp)}, rowid LIMIT 200
    )`.execute(database);
  }
}

/** A successful pass leaves overdue backlog one bounded continuation away. */
export async function ownerRetentionWake(
  database: Kysely<OwnerDatabase>,
  now: number,
): Promise<number | null> {
  const deadlines: number[] = [];
  for (const { table, timestamp, retention } of policies) {
    const row = await sql<{
      oldest: number | null;
    }>`SELECT MIN(${sql.ref(timestamp)}) AS oldest FROM ${sql.table(table)}`.execute(
      database,
    );
    const oldest = row.rows[0]!.oldest;
    if (oldest !== null)
      deadlines.push(
        oldest + retention <= now
          ? now + 1_000
          : retentionWake(oldest, retention),
      );
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}
