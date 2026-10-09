import { logEvent } from "@/server/telemetry";
import { drainAttachments } from "./attachments/cleanup";
import {
  drainDirectorySync,
  publishMembershipBatch,
  DIRECTORY_SYNC_AT,
} from "./directory-sync";
import { drainMediaInvalidations } from "./media-invalidations";
import { mediaRoomKey } from "@/server/media/authorization";
import { replaceAlarm, socketCleanupWake } from "./alarms";
import { ownerRetentionWake, pruneOwnerRetention } from "./retention";
import { attachment, reevaluateSockets } from "./sockets";
import { sql, type Kysely } from "kysely";
import type { OwnerDatabase } from "./database";

/** Recompute under the native transaction so an enqueue cannot race the reset. */
export async function refreshOwnerAlarm(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
) {
  await ctx.storage.transaction(async () => {
    const now = Date.now();
    // Scalar subqueries avoid workerd's small compound-SELECT term limit.
    const result = await sql<Record<string, number | null>>`
      SELECT
        (SELECT MIN(eligible_at) FROM deleted_payloads) AS payload,
        (SELECT MIN(expires_at) FROM socket_tickets) AS ticket,
        (SELECT MIN(MAX(next_attempt_at, COALESCE(lease_expires_at, 0))) FROM media_invalidations) AS media,
        (SELECT MIN(deadline) FROM attachments WHERE deadline IS NOT NULL) AS attachment,
        (SELECT MIN(MAX(cleanup_at, COALESCE(cleanup_lease_expires_at, 0)))
          FROM attachments WHERE cleanup_at IS NOT NULL AND preservation_hold = 0) AS cleanup
      `.execute(database);
    const leases = ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => {
        const value = attachment(socket);
        return value && value.leaseExpiresAt > now
          ? socketCleanupWake(value.leaseExpiresAt, now)
          : socketCleanupWake(now, now);
      });
    const { ticket, ...obligations } = result.rows[0]!;
    if (ticket !== null && ticket !== undefined)
      leases.push(socketCleanupWake(ticket, now));
    for (const due of Object.values(obligations))
      // Residual expiry/cleanup batches continue in one second; stored future
      // validity/retry/lease times stay exact. Failed local passes never refresh.
      if (due !== null) leases.push(due <= now ? now + 1_000 : due);
    const retention = await ownerRetentionWake(database, now);
    if (retention !== null) leases.push(retention);
    const directorySyncAt = await ctx.storage.get<number>(DIRECTORY_SYNC_AT);
    if (directorySyncAt !== undefined)
      leases.push(directorySyncAt <= now ? now + 1_000 : directorySyncAt);
    await replaceAlarm(ctx.storage, leases.length ? Math.min(...leases) : null);
  });
}

export async function ownerAlarm(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
) {
  await reevaluateSockets(ctx, database);
  await ctx.storage.transaction(async () => {
    const now = Date.now();
    await pruneOwnerRetention(database, now);
    // Keep the 200-row batch below workerd's 100-bound-variable SQL limit.
    await sql`DELETE FROM deleted_payloads WHERE message_id IN (
      SELECT message_id FROM deleted_payloads WHERE eligible_at <= ${now}
      ORDER BY eligible_at, message_id LIMIT 200
    )`.execute(database);
    await database
      .deleteFrom("socket_tickets")
      .where("expires_at", "<=", now)
      .execute();
    await refreshOwnerAlarm(ctx, database);
  });
}

export async function maintainOwner(
  ctx: DurableObjectState,
  env: Env,
  database: Kysely<OwnerDatabase>,
  onDirectoryPublished: () => Promise<void>,
) {
  // Local expiry and its successor commit before any external drain suspends.
  // Failed local storage work retains the platform retry boundary.
  try {
    await ownerAlarm(ctx, database);
  } catch (error) {
    logEvent(
      "error",
      "owner_alarm_failed",
      {
        actorId: ctx.id.toString(),
        operation: "sockets",
      },
      error,
    );
    throw error;
  }
  try {
    const results = await Promise.allSettled([
      drainMediaInvalidations(ctx, database, (request) =>
        env.MEDIA_ROOM.getByName(mediaRoomKey(request.room)).invalidate(
          request,
        ),
      ),
      drainAttachments(ctx, database, env.ATTACHMENTS),
      drainDirectorySync(ctx.storage, database, (id, members) =>
        publishMembershipBatch(env, id, members),
      ).then((published) => {
        if (published) return onDirectoryPublished();
      }),
    ]);
    const operations = [
      "media_invalidation",
      "attachments",
      "directory_sync",
    ] as const;
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected")
        logEvent(
          "error",
          "owner_alarm_failed",
          {
            actorId: ctx.id.toString(),
            operation: operations[index]!,
          },
          result.reason,
        );
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    // Enqueues made during external I/O must survive this complete fresh read.
    await refreshOwnerAlarm(ctx, database);
  }
  // Opportunistic planner maintenance must not retry completed cleanup.
  try {
    ctx.storage.sql.exec("PRAGMA optimize");
  } catch (error) {
    logEvent(
      "warn",
      "owner_optimization_failed",
      { actorId: ctx.id.toString() },
      error,
    );
  }
}
