import {
  scheduleAlarm,
  socketCleanupWake,
  replaceAlarm,
} from "@/server/actors/shared/alarms";
import { accountSockets, attachment, close } from "./sockets";
import { sql, type Kysely } from "kysely";
import type { EventDispatchDatabase } from "./store";
import { socketPresenceDeadline, recomputePresence } from "./presence";

/** Caller holds the native transaction; one alarm covers all hub deadlines. */
export async function refreshDispatchAlarm(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
) {
  const result = await sql<Record<string, number | null>>`SELECT
    (SELECT MIN(expires_at) FROM dispatch_tickets) AS ticket,
    (SELECT MIN(expires_at) FROM dispatch_revoked_sessions) AS revocation
  `.execute(db);
  let due = Infinity;
  const { ticket, revocation } = result.rows[0]!;
  if (ticket !== null && ticket !== undefined) due = socketCleanupWake(ticket);
  if (revocation !== null && revocation !== undefined)
    due = Math.min(due, revocation);
  for (const socket of ctx.getWebSockets())
    if (socket.readyState === WebSocket.OPEN)
      due = Math.min(
        due,
        socketCleanupWake(socketPresenceDeadline(ctx, socket)),
      );
  await replaceAlarm(ctx.storage, Number.isFinite(due) ? due : null);
}
export async function alarmDispatch(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
) {
  return ctx.storage.transaction(async () => {
    const now = Date.now();
    const accounts = await db
      .selectFrom("dispatch_accounts")
      .select("user_id")
      .where("online", "=", 1)
      .execute();
    const userIds = new Set(accounts.map((account) => account.user_id));
    // Failed close acknowledgements can leave OPEN sockets after presence became
    // offline. They still require cleanup and retain their hub capacity slot.
    for (const socket of ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const value = attachment(socket);
      if (value) userIds.add(value.userId);
      else close(ctx, socket, "lease_expired");
    }
    const changed = await recomputePresence(ctx, db, [...userIds]);
    await db
      .deleteFrom("dispatch_tickets")
      .where("expires_at", "<=", now)
      .execute();
    await db
      .deleteFrom("dispatch_revoked_sessions")
      .where("expires_at", "<=", now)
      .execute();
    await refreshDispatchAlarm(ctx, db);
    return changed;
  });
}

/** A targeted change can advance the alarm; harmless obsolete deadlines are cleared by its sweep. */
export async function scheduleAccountAlarm(
  ctx: DurableObjectState,
  userIds: readonly string[],
) {
  let due = Infinity;
  for (const userId of new Set(userIds)) {
    for (const socket of accountSockets(ctx, userId))
      if (socket.readyState === WebSocket.OPEN)
        due = Math.min(due, socketPresenceDeadline(ctx, socket));
  }
  if (Number.isFinite(due))
    await scheduleAlarm(ctx.storage, socketCleanupWake(due));
}
