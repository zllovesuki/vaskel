import { sql, type Kysely } from "kysely";
import type { MediaRoomRef } from "@vaskel/contracts/media";
import type { CloseOutcome } from "@/server/actors/media/media-room-do";
import type { OwnerDatabase } from "./database";
import { getState, ownerScope } from "./policy";
import { scheduleAlarm } from "./alarms";
import { actorWork, ACTOR_WORK_BUDGET_MS } from "./bounded-work";

export type MediaInvalidationRequest = {
  room: MediaRoomRef;
  userIds: string[];
  permissionGeneration: number;
};
export type MediaInvalidationSender = (
  request: MediaInvalidationRequest,
) => Promise<CloseOutcome>;

/** Runs inside the same native transaction as the permission mutation. */
export async function queueMediaInvalidations(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  channelIds: readonly string[],
  userId: string,
  permissionGeneration: number,
): Promise<boolean> {
  const now = Date.now();
  // Ten rows keep each query below 100 binds, even at the channel cap.
  for (let offset = 0; offset < channelIds.length; offset += 10) {
    const rows = channelIds.slice(offset, offset + 10).map((channel_id) => ({
      channel_id,
      user_id: userId,
      permission_generation: permissionGeneration,
      next_attempt_at: now,
    }));
    await database
      .insertInto("media_invalidations")
      .values(rows)
      .onConflict((conflict) =>
        conflict
          .columns(["channel_id", "user_id"])
          .doUpdateSet({
            permission_generation: permissionGeneration,
            next_attempt_at: now,
            attempts: 0,
            lease_id: null,
            lease_expires_at: null,
          })
          .where(
            "media_invalidations.permission_generation",
            "<",
            permissionGeneration,
          ),
      )
      .execute();
  }
  if (channelIds.length) await scheduleAlarm(storage, now + 1);
  return channelIds.length > 0;
}

export async function drainMediaInvalidations(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  send: MediaInvalidationSender,
): Promise<void> {
  const deadline = Date.now() + ACTOR_WORK_BUDGET_MS;
  const now = Date.now();
  const claims = await ctx.storage.transaction(async () => {
    const rows = await database
      .selectFrom("media_invalidations")
      .selectAll()
      .where("next_attempt_at", "<=", now)
      .where((expression) =>
        expression.or([
          expression("lease_expires_at", "is", null),
          expression("lease_expires_at", "<=", now),
        ]),
      )
      .orderBy("next_attempt_at")
      .limit(10)
      .execute();
    const state = await getState(database);
    if (!state) return [];
    const claimed = [];
    for (const row of rows) {
      const leaseId = crypto.randomUUID();
      await database
        .updateTable("media_invalidations")
        .set({
          lease_id: leaseId,
          lease_expires_at: now + 30_000,
          attempts: row.attempts + 1,
        })
        .where("channel_id", "=", row.channel_id)
        .where("user_id", "=", row.user_id)
        .execute();
      claimed.push({ ...row, leaseId, owner: ownerScope(state) });
    }
    // Persist the next wakeup before starting any inter-actor RPC.
    if (claimed.length) await scheduleAlarm(ctx.storage, now + 30_000);
    return claimed;
  });
  const results = await actorWork(ctx.storage, "maintenance").map(
    claims,
    (claim) =>
      send({
        room: { owner: claim.owner, channelId: claim.channel_id },
        userIds: [claim.user_id],
        permissionGeneration: claim.permission_generation,
      }),
    deadline,
    (claim) => `media:${claim.channel_id}`,
  );
  for (const [index, claim] of claims.entries()) {
    const result = results[index]!;
    // Lost or timed-out acknowledgements keep the idempotent durable obligation.
    const closed = result.ok && result.value.kind === "closed";
    await ctx.storage.transaction(async () => {
      const query = database
        .deleteFrom("media_invalidations")
        .where("channel_id", "=", claim.channel_id)
        .where("user_id", "=", claim.user_id)
        .where("permission_generation", "=", claim.permission_generation)
        .where("lease_id", "=", claim.leaseId);
      if (closed) await query.execute();
      else
        await database
          .updateTable("media_invalidations")
          .set({
            lease_id: null,
            lease_expires_at: null,
            next_attempt_at:
              Date.now() +
              Math.min(60_000, 1_000 * 2 ** Math.min(claim.attempts, 6)),
          })
          .where("channel_id", "=", claim.channel_id)
          .where("user_id", "=", claim.user_id)
          .where("permission_generation", "=", claim.permission_generation)
          .where("lease_id", "=", claim.leaseId)
          .execute();
    });
  }
  await ctx.storage.transaction(async () => {
    const pending = await sql<{
      at: number | null;
    }>`SELECT MIN(MAX(next_attempt_at, COALESCE(lease_expires_at, 0))) AS at FROM media_invalidations`.execute(
      database,
    );
    const due = pending.rows[0]?.at;
    if (due !== null && due !== undefined)
      await scheduleAlarm(ctx.storage, due);
  });
}
