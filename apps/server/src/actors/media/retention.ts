import type { RoomRuntime } from "./store";

/** Beyond the 90s command window, 30s grants and bounded provider exchanges. */
export const MEDIA_TERMINAL_RETENTION_MS = 5 * 60_000;
const CLEANUP_BATCH = 200;

// A closed participant is a fence, not permission to forget unsettled resources.
const settledParticipant = `p.status='left' AND p.cancellation_pending=0 AND p.cleanup_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM media_sessions s
    WHERE s.participant_id=p.id AND s.generation=p.generation
      AND s.phase<>'closed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM media_allocations a JOIN media_sessions s ON s.session_key=a.session_key
    WHERE s.participant_id=p.id AND s.generation=p.generation
  )`;
const participantWork = `(
  EXISTS (SELECT 1 FROM media_sessions s WHERE s.participant_id=p.id AND s.generation=p.generation)
  OR EXISTS (SELECT 1 FROM media_publications pub WHERE pub.participant_id=p.id AND pub.generation=p.generation)
  OR EXISTS (SELECT 1 FROM media_operations op WHERE op.participant_id=p.id AND op.generation=p.generation)
  OR EXISTS (SELECT 1 FROM media_participants newer WHERE newer.user_id=p.user_id AND newer.generation>p.generation)
)`;
const settledOperation = `NOT EXISTS (
    SELECT 1 FROM media_sessions s
    WHERE s.participant_id=op.participant_id AND s.generation=op.generation
      AND s.direction=op.direction AND s.operation_id=op.operation_id AND s.phase<>'closed'
  ) AND NOT EXISTS (
    SELECT 1 FROM media_participants p
    WHERE p.id=op.participant_id AND p.generation=op.generation
      AND (p.status='closing' OR p.cancellation_pending<>0)
  )`;

// Filter before LIMIT so protected early generations cannot starve later rows.
function notInflight(id: string, generation: string) {
  const key = `(${id} || ':' || ${generation})`;
  return `NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value IN (
    'admission:' || ${key}, 'cleanup:' || ${key},
    ${key} || ':producer', ${key} || ':consumer',
    'scope:' || ${key} || ':producer', 'scope:' || ${key} || ':consumer'
  ))`;
}

/** One native commit removes at most 200 settled records. */
export function pruneMediaRecords(rt: RoomRuntime, now: number) {
  return rt.ctx.storage.transactionSync(() => {
    const sql = rt.ctx.storage.sql;
    let remaining = CLEANUP_BATCH;
    const inflight = JSON.stringify([...rt.inflight.keys()]);
    const closed = sql
      .exec<{ id: string; generation: number }>(
        `SELECT p.id,p.generation FROM media_participants p
         WHERE ${participantWork} AND (
           (${settledParticipant} AND p.closed_at <= ?)
           OR (p.status='left' AND p.reason='transfer' AND p.cancellation_pending=0 AND p.cleanup_at IS NULL)
         ) AND ${notInflight("p.id", "p.generation")}
         ORDER BY p.closed_at LIMIT 16`,
        now - MEDIA_TERMINAL_RETENTION_MS,
        inflight,
      )
      .toArray();
    // Table names/predicates below are internal constants; values stay bound.
    const remove = (
      table: string,
      predicate: string,
      id: string,
      generation: number,
    ) => {
      if (remaining === 0) return;
      remaining -= sql
        .exec(
          `DELETE FROM ${table} WHERE rowid IN (
             SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?
           ) RETURNING rowid`,
          id,
          generation,
          remaining,
        )
        .toArray().length;
    };
    for (const p of closed) {
      if (remaining === 0) break;
      remove(
        "media_operations",
        "participant_id=? AND generation=?",
        p.id,
        p.generation,
      );
      remove(
        "media_publications",
        "participant_id=? AND generation=?",
        p.id,
        p.generation,
      );
      remove(
        "media_subscriptions",
        "session_key IN (SELECT session_key FROM media_sessions WHERE participant_id=? AND generation=?)",
        p.id,
        p.generation,
      );
      remove(
        "media_allocations",
        "session_key IN (SELECT session_key FROM media_sessions WHERE participant_id=? AND generation=?)",
        p.id,
        p.generation,
      );
      remove(
        "media_sessions",
        "participant_id=? AND generation=?",
        p.id,
        p.generation,
      );
      // Exhausting the budget retains the parent until its next bounded pass.
      // The newest participant remains forever: account receipts can retry the
      // same generation after command expiry, without authorizing readmission.
      remove(
        "media_participants",
        `id=? AND generation=? AND EXISTS (
          SELECT 1 FROM media_participants newer
          WHERE newer.user_id=media_participants.user_id
            AND newer.generation>media_participants.generation
        )`,
        p.id,
        p.generation,
      );
    }
    if (remaining === 0) return;
    const operations = sql
      .exec<{ rowid: number; participant_id: string; generation: number }>(
        `SELECT op.rowid,op.participant_id,op.generation FROM media_operations op
         WHERE op.created_at <= ? AND ${settledOperation} AND ${notInflight("op.participant_id", "op.generation")}
         ORDER BY op.created_at LIMIT ?`,
        now - MEDIA_TERMINAL_RETENTION_MS,
        inflight,
        remaining,
      )
      .toArray();
    for (const op of operations) {
      sql.exec("DELETE FROM media_operations WHERE rowid=?", op.rowid);
      remaining--;
    }
    if (remaining > 0)
      sql.exec(
        `DELETE FROM media_moderation_receipts WHERE rowid IN (
          SELECT rowid FROM media_moderation_receipts WHERE created_at <= ?
          ORDER BY created_at LIMIT ?
        )`,
        now - MEDIA_TERMINAL_RETENTION_MS,
        remaining,
      );
  });
}

/** Caller includes these deadlines in the room's existing single alarm. */
export function mediaRetentionWake(rt: RoomRuntime, now: number) {
  const sql = rt.ctx.storage.sql;
  const participant = sql
    .exec<{ at: number | null }>(
      `SELECT MIN(CASE WHEN p.reason='transfer' THEN p.closed_at ELSE p.closed_at + ? END) AS at
       FROM media_participants p
       WHERE (${settledParticipant} OR (p.status='left' AND p.reason='transfer' AND p.cancellation_pending=0 AND p.cleanup_at IS NULL))
       AND ${participantWork}`,
      MEDIA_TERMINAL_RETENTION_MS,
    )
    .one().at;
  const operation = sql
    .exec<{ at: number | null }>(
      `SELECT MIN(op.created_at) + ? AS at FROM media_operations op
       WHERE ${settledOperation}`,
      MEDIA_TERMINAL_RETENTION_MS,
    )
    .one().at;
  const moderation = sql
    .exec<{ at: number | null }>(
      "SELECT MIN(created_at) + ? AS at FROM media_moderation_receipts",
      MEDIA_TERMINAL_RETENTION_MS,
    )
    .one().at;
  const deadlines = [participant, operation, moderation].filter(
    (at) => at !== null,
  );
  if (!deadlines.length) return null;
  const next = Math.min(...deadlines);
  return next <= now ? now + 1_000 : next;
}
