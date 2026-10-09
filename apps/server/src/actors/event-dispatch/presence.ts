import type { Kysely } from "kysely";
import type { PresenceSample } from "@vaskel/contracts/presence";
import { accountSockets, attachment, close } from "./sockets";
import {
  accountSnapshots,
  type AccountSnapshot,
  type EventDispatchDatabase,
} from "./store";

export const EVENT_DISPATCH_SILENCE_MS = 90_000;

export function socketPresenceDeadline(
  ctx: DurableObjectState,
  socket: WebSocket,
) {
  const value = attachment(socket);
  return value
    ? Math.min(
        value.leaseExpiresAt,
        Math.max(
          value.openedAt,
          ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0,
        ) + EVENT_DISPATCH_SILENCE_MS,
      )
    : 0;
}
export function accountEligibility(
  ctx: DurableObjectState,
  userId: string,
  now: number,
  snapshot: AccountSnapshot,
) {
  return (socket: WebSocket) => {
    const value = attachment(socket);
    return Boolean(
      socket.readyState === WebSocket.OPEN &&
      value &&
      value.userId === userId &&
      socketPresenceDeadline(ctx, socket) > now &&
      value.authEpoch >= (snapshot.account?.minimum_auth_epoch ?? 0) &&
      !snapshot.revoked.has(value.sessionId),
    );
  };
}
/** Caller holds the native transaction. Writes only first/last transitions. */
export async function recomputePresence(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
  userIds: readonly string[],
) {
  const changed: string[] = [];
  const now = Date.now();
  const snapshots = await accountSnapshots(db, userIds, now);
  for (const userId of new Set(userIds)) {
    const snapshot = snapshots.get(userId)!;
    const state = snapshot.account;
    if (!state) continue;
    const eligible = accountEligibility(ctx, userId, now, snapshot);
    let online = false;
    for (const socket of accountSockets(ctx, userId)) {
      const value = attachment(socket);
      if (eligible(socket)) online = true;
      else if (socket.readyState === WebSocket.OPEN)
        close(
          ctx,
          socket,
          value &&
            (value.authEpoch < state.minimum_auth_epoch ||
              snapshot.revoked.has(value.sessionId))
            ? "revoked"
            : "lease_expired",
        );
    }
    if (state.online !== Number(online))
      await db
        .updateTable("dispatch_accounts")
        .set({ online: Number(online) })
        .where("user_id", "=", userId)
        .execute();
    if (state.online !== Number(online)) changed.push(userId);
  }
  return changed;
}
/** Read-only: native pong timestamps do not require periodic SQL renewal. */
export async function samplePresence(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
  userIds: readonly string[],
): Promise<PresenceSample[]> {
  const sampledAt = Date.now();
  const samples: PresenceSample[] = [];
  const snapshots = await accountSnapshots(db, userIds, sampledAt);
  for (const userId of new Set(userIds)) {
    const snapshot = snapshots.get(userId)!;
    const eligible = accountEligibility(ctx, userId, sampledAt, snapshot);
    const online = accountSockets(ctx, userId).some(eligible);
    samples.push({ userId, state: online ? "online" : "offline", sampledAt });
  }
  return samples;
}
