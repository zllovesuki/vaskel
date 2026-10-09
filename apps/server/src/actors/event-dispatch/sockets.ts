import type { Kysely } from "kysely";
import { z } from "zod";
import {
  EVENT_DISPATCH_SOCKET_LIMIT,
  EVENT_DISPATCH_TICKET_LIMIT,
} from "@/server/event-dispatch/limits";
import {
  ACCOUNT_EVENTS_LEASE_MS,
  ACCOUNT_EVENTS_SOCKET_LIMIT,
  ACCOUNT_EVENTS_TICKET_MS,
  type AccountEventFrame,
  type AccountEventOutcome,
} from "@vaskel/contracts/account-events";
import {
  scheduleAlarm,
  socketCleanupWake,
} from "@/server/actors/shared/alarms";
import { secret } from "@/server/actors/shared/policy";
import { sha256Hex } from "@/server/auth/crypto";
import {
  bindAccount,
  sessionRevoked,
  type EventDispatchDatabase,
  type EventDispatchPrincipal,
} from "./store";

const AttachmentSchema = z.strictObject({
  connectionId: z.uuid(),
  userId: z.uuid(),
  openedAt: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  authEpoch: z.number().int().nonnegative(),
  leaseExpiresAt: z.number().int().nonnegative(),
});
export type EventDispatchAttachment = z.infer<typeof AttachmentSchema>;
export function attachment(socket: WebSocket) {
  const parsed = AttachmentSchema.safeParse(socket.deserializeAttachment());
  return parsed.success ? parsed.data : undefined;
}
export function send(socket: WebSocket, notice: AccountEventFrame) {
  socket.send(JSON.stringify(notice));
}
export function close(
  ctx: DurableObjectState,
  socket: WebSocket,
  type: "revoked" | "lease_expired",
) {
  try {
    send(socket, { type });
  } catch {
    /* A lost transport reconnects through authenticated ingress. */
  }
  try {
    socket.close(4001, type);
  } catch {
    /* Already closed or transport failure; an OPEN socket still owns capacity. */
  } finally {
    releaseConnection(ctx, socket);
  }
}
export async function prepareSocket(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
  principal: EventDispatchPrincipal,
): Promise<AccountEventOutcome> {
  const ticket = secret();
  const ticketHash = await sha256Hex(ticket);
  return ctx.storage.transaction(async () => {
    const now = Date.now();
    if (
      principal.expiresAt <= now ||
      principal.sessionExpiresAt <= now ||
      (await sessionRevoked(
        db,
        principal.userId,
        principal.sessionId,
        principal.authEpoch,
      ))
    )
      return { kind: "unauthenticated" };
    await bindAccount(db, principal.userId);
    await db
      .deleteFrom("dispatch_tickets")
      .where("expires_at", "<=", now)
      .execute();
    const count = await db
      .selectFrom("dispatch_tickets")
      .select((e) => e.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    if (
      count.count >= EVENT_DISPATCH_TICKET_LIMIT ||
      (
        await db
          .selectFrom("dispatch_tickets")
          .select((e) => e.fn.countAll<number>().as("count"))
          .where("user_id", "=", principal.userId)
          .executeTakeFirstOrThrow()
      ).count >= ACCOUNT_EVENTS_SOCKET_LIMIT ||
      openSocketCount(ctx, principal.userId) >= ACCOUNT_EVENTS_SOCKET_LIMIT ||
      openSocketCount(ctx) >= EVENT_DISPATCH_SOCKET_LIMIT
    )
      return { kind: "capacity" };
    const expiresAt = Math.min(
      now + ACCOUNT_EVENTS_TICKET_MS,
      principal.expiresAt,
      principal.sessionExpiresAt,
    );
    const leaseExpiresAt = Math.min(
      now + ACCOUNT_EVENTS_LEASE_MS,
      principal.sessionExpiresAt,
    );
    await db
      .insertInto("dispatch_tickets")
      .values({
        ticket_hash: ticketHash,
        user_id: principal.userId,
        session_id: principal.sessionId,
        auth_epoch: principal.authEpoch,
        expires_at: expiresAt,
        lease_expires_at: leaseExpiresAt,
      })
      .execute();
    await scheduleAlarm(ctx.storage, socketCleanupWake(expiresAt));
    return { kind: "event_ticket", ticket, expiresAt, leaseExpiresAt };
  });
}
export async function upgradeSocket(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
  request: Request,
) {
  if (
    request.method !== "GET" ||
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
  )
    return new Response("WebSocket upgrade required", { status: 426 });
  const offered =
    request.headers
      .get("Sec-WebSocket-Protocol")
      ?.split(",")
      .map((v) => v.trim()) ?? [];
  const capabilities = offered.filter((v) =>
    /^vaskel-ticket\.[0-9a-f]{64}$/.test(v),
  );
  if (
    offered.length !== 2 ||
    !offered.includes("vaskel-account-events-v1") ||
    capabilities.length !== 1
  )
    return new Response("Invalid socket protocol", { status: 400 });
  // These are overwritten by the private Worker bridge after primary-backed session validation.
  const userId = request.headers.get("X-Vaskel-User-Id");
  const sessionId = request.headers.get("X-Vaskel-Session-Id");
  const authEpoch = Number(request.headers.get("X-Vaskel-Auth-Epoch"));
  const sessionExpiresAt = Number(
    request.headers.get("X-Vaskel-Session-Expires-At"),
  );
  if (
    !userId ||
    !sessionId ||
    !request.headers.has("X-Vaskel-Auth-Epoch") ||
    !Number.isSafeInteger(authEpoch) ||
    authEpoch < 0 ||
    !Number.isSafeInteger(sessionExpiresAt) ||
    sessionExpiresAt <= Date.now()
  )
    return new Response("Socket authorization expired", { status: 403 });
  const ticketHash = await sha256Hex(
    capabilities[0]!.slice("vaskel-ticket.".length),
  );
  const admitted = await ctx.storage.transaction(async () => {
    if (await sessionRevoked(db, userId, sessionId, authEpoch)) return null;
    const ticket = await db
      .selectFrom("dispatch_tickets")
      .selectAll()
      .where("ticket_hash", "=", ticketHash)
      .executeTakeFirst();
    const now = Date.now();
    if (
      !ticket ||
      ticket.user_id !== userId ||
      ticket.session_id !== sessionId ||
      ticket.auth_epoch !== authEpoch ||
      ticket.expires_at <= now ||
      ticket.lease_expires_at <= now
    )
      return null;
    await db
      .deleteFrom("dispatch_tickets")
      .where("ticket_hash", "=", ticketHash)
      .execute();
    if (
      openSocketCount(ctx, userId) >= ACCOUNT_EVENTS_SOCKET_LIMIT ||
      openSocketCount(ctx) >= EVENT_DISPATCH_SOCKET_LIMIT
    )
      return { kind: "capacity" } as const;
    const value: EventDispatchAttachment = {
      connectionId: crypto.randomUUID(),
      userId,
      openedAt: now,
      sessionId,
      authEpoch,
      leaseExpiresAt: Math.min(ticket.lease_expires_at, sessionExpiresAt),
    };
    await scheduleAlarm(ctx.storage, socketCleanupWake(value.leaseExpiresAt));
    const pair = new WebSocketPair();
    // Accept before releasing the transaction so competing upgrades see the slot.
    ctx.acceptWebSocket(pair[1], [
      accountTag(userId),
      sessionTag(userId, sessionId),
    ]);
    pair[1].serializeAttachment(value);
    connections(ctx).set(value.connectionId, pair[1]);
    return { pair, value };
  });
  if (!admitted)
    return new Response("Socket authorization expired", { status: 403 });
  if ("kind" in admitted) return Response.json(admitted, { status: 429 });
  send(admitted.pair[1], {
    type: "ready",
    leaseExpiresAt: admitted.value.leaseExpiresAt,
    resync: true,
  });
  return new Response(null, {
    status: 101,
    webSocket: admitted.pair[0],
    headers: { "Sec-WebSocket-Protocol": "vaskel-account-events-v1" },
  });
}

export function accountTag(userId: string) {
  return `account:${userId}`;
}
export function sessionTag(userId: string, sessionId: string) {
  return `session:${userId}:${sessionId}`;
}
export function accountSockets(ctx: DurableObjectState, userId: string) {
  return ctx.getWebSockets(accountTag(userId));
}
const indexes = new WeakMap<DurableObjectStorage, Map<string, WebSocket>>();
function connections(ctx: DurableObjectState) {
  let index = indexes.get(ctx.storage);
  if (!index) {
    index = new Map();
    for (const socket of ctx.getWebSockets()) {
      const value = attachment(socket);
      if (value && socket.readyState === WebSocket.OPEN)
        index.set(value.connectionId, socket);
    }
    indexes.set(ctx.storage, index);
  }
  return index;
}
export function reconstructConnections(ctx: DurableObjectState) {
  connections(ctx);
}
export function releaseConnection(ctx: DurableObjectState, socket: WebSocket) {
  const value = attachment(socket);
  if (value && socket.readyState !== WebSocket.OPEN)
    connections(ctx).delete(value.connectionId);
}
export function openSocketCount(ctx: DurableObjectState, userId?: string) {
  return userId
    ? accountSockets(ctx, userId).filter((s) => s.readyState === WebSocket.OPEN)
        .length
    : connections(ctx).size;
}
