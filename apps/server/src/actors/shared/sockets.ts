import type { Kysely } from "kysely";
import { z } from "zod";
import {
  SOCKET_LEASE_MS,
  SOCKET_TICKET_MS,
  type MessagingOutcome,
  type PrepareSocket,
  type RenewSocket,
  type Receipt,
  type ServerEvent,
} from "@vaskel/contracts/messaging";
import type { Principal, SessionAssertion } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import {
  access,
  type AuthorizedChannel,
  cursor,
  getState,
  principalFailure,
  readChannelReaders,
  secret,
} from "./policy";
import { materializeForReaders } from "./message-materialization";
import { sha256Hex } from "@/server/auth/crypto";
import { scheduleAlarm, socketCleanupWake } from "./alarms";
import { newSendFailure } from "./send-policy";
import { outcomeResponse } from "@/server/http/orpc";

const SocketAttachmentSchema = z.strictObject({
  connectionId: z.uuid(),
  userId: z.string(),
  sessionId: z.string(),
  channelId: z.string(),
  leaseExpiresAt: z.number().int(),
});
type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;
export function attachment(socket: WebSocket): SocketAttachment | undefined {
  const parsed = SocketAttachmentSchema.safeParse(
    socket.deserializeAttachment(),
  );
  return parsed.success ? parsed.data : undefined;
}
function assertion(value: SocketAttachment): SessionAssertion {
  return {
    userId: value.userId,
    sessionId: value.sessionId,
    expiresAt: value.leaseExpiresAt,
  };
}
export function sendFrame(socket: WebSocket, frame: ServerEvent) {
  socket.send(JSON.stringify(frame));
}
function closeSocket(
  socket: WebSocket,
  type: "access_changed" | "lease_expired",
) {
  try {
    sendFrame(socket, { type });
  } catch {
    /* An explanatory frame cannot gate native closure. */
  }
  try {
    socket.close(4001, type);
  } catch {
    /* Closed transports recover with a fresh authenticated connection. */
  }
}
type AuthorizedSocket = {
  socket: WebSocket;
  value: SocketAttachment;
  authorized: AuthorizedChannel;
};
/** A socket keeps receiving only while its lease and current channel access hold. */
async function authorizeSocket(
  database: Kysely<OwnerDatabase>,
  socket: WebSocket,
  value: SocketAttachment | undefined,
): Promise<AuthorizedSocket | null> {
  if (!value || value.leaseExpiresAt <= Date.now()) {
    closeSocket(socket, "lease_expired");
    return null;
  }
  const authorized = await access(database, assertion(value), value.channelId);
  if (authorized.kind !== "authorized") {
    closeSocket(socket, "access_changed");
    return null;
  }
  return { socket, value, authorized };
}
// Leave room for channel and visibility parameters below the native limit of 100.
const SOCKET_READER_BATCH_SIZE = 64;

/** Fresh shared authority, with each connection's lease checked at delivery. */
async function* authorizedSockets(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  accept: (value: SocketAttachment) => boolean = () => true,
) {
  const candidates: { socket: WebSocket; value: SocketAttachment }[] = [];
  const usersByChannel = new Map<string, Set<string>>();
  for (const socket of ctx.getWebSockets()) {
    const value = attachment(socket);
    // Other channels retain their own traffic and alarm-based rechecks.
    if (value && !accept(value)) continue;
    if (!value || value.leaseExpiresAt <= Date.now()) {
      closeSocket(socket, "lease_expired");
      continue;
    }
    candidates.push({ socket, value });
    const users = usersByChannel.get(value.channelId) ?? new Set<string>();
    users.add(value.userId);
    usersByChannel.set(value.channelId, users);
  }
  if (candidates.length === 0) return;

  const state = await getState(database);
  const readersByChannel = new Map<string, Set<string>>();
  if (state) {
    for (const [channelId, users] of usersByChannel) {
      const userIds = [...users];
      const readers = new Set<string>();
      for (
        let offset = 0;
        offset < userIds.length;
        offset += SOCKET_READER_BATCH_SIZE
      ) {
        for (const row of await readChannelReaders(
          database,
          channelId,
          userIds.slice(offset, offset + SOCKET_READER_BATCH_SIZE),
        ))
          readers.add(row.user_id);
      }
      readersByChannel.set(channelId, readers);
    }
  }
  for (const { socket, value } of candidates) {
    // Batch reads cannot extend the authority of an individual connection.
    if (value.leaseExpiresAt <= Date.now()) {
      closeSocket(socket, "lease_expired");
    } else if (
      !state ||
      !readersByChannel.get(value.channelId)?.has(value.userId)
    ) {
      closeSocket(socket, "access_changed");
    } else {
      yield { socket, value, state };
    }
  }
}
export async function prepareSocket(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: PrepareSocket,
): Promise<MessagingOutcome> {
  const ticket = secret();
  const ticketHash = await sha256Hex(ticket);
  return storage.transaction(async () => {
    const authorized = await access(database, principal, input.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const now = Date.now();
    const expiresAt = Math.min(now + SOCKET_TICKET_MS, principal.expiresAt);
    const leaseExpiresAt = Math.min(now + SOCKET_LEASE_MS, principal.expiresAt);
    await database
      .deleteFrom("socket_tickets")
      .where("expires_at", "<=", now)
      .execute();
    const count = await database
      .selectFrom("socket_tickets")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("user_id", "=", principal.userId)
      .executeTakeFirstOrThrow();
    if (count.count >= 8) return { kind: "capacity" };
    const total = await database
      .selectFrom("socket_tickets")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    if (total.count >= 256) return { kind: "capacity" };
    await database
      .insertInto("socket_tickets")
      .values({
        ticket_hash: ticketHash,
        user_id: principal.userId,
        session_id: principal.sessionId,
        channel_id: input.channelId,
        expires_at: expiresAt,
        lease_expires_at: leaseExpiresAt,
      })
      .execute();
    await scheduleAlarm(storage, socketCleanupWake(expiresAt));
    return { kind: "socket_ticket", ticket, expiresAt, leaseExpiresAt };
  });
}
export async function upgradeSocket(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  request: Request,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
  )
    return new Response("WebSocket upgrade required", { status: 426 });
  const offered =
    request.headers
      .get("Sec-WebSocket-Protocol")
      ?.split(",")
      .map((value) => value.trim()) ?? [];
  const capabilities = offered.filter((value) =>
    /^vaskel-ticket\.[0-9a-f]{64}$/.test(value),
  );
  if (
    !offered.includes("vaskel-v1") ||
    capabilities.length !== 1 ||
    offered.length !== 2
  )
    return new Response("Invalid socket protocol", { status: 400 });
  // The public Worker overwrites these headers after a fresh D1 session read;
  // this private upgrade bridge never accepts a client-selected principal.
  const userId = request.headers.get("X-Vaskel-User-Id");
  const sessionId = request.headers.get("X-Vaskel-Session-Id");
  const expiresAt = Number(
    request.headers.get("X-Vaskel-Assertion-Expires-At"),
  );
  if (
    !userId ||
    !sessionId ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  )
    return new Response("Socket authorization expired", { status: 403 });
  const ticketHash = await sha256Hex(
    capabilities[0]!.slice("vaskel-ticket.".length),
  );
  const admitted = await ctx.storage.transaction(async () => {
    const ticket = await database
      .selectFrom("socket_tickets")
      .selectAll()
      .where("ticket_hash", "=", ticketHash)
      .executeTakeFirst();
    const bound =
      ticket &&
      ticket.user_id === userId &&
      ticket.session_id === sessionId &&
      ticket.expires_at > Date.now() &&
      ticket.lease_expires_at > Date.now();
    const principal = { userId, sessionId, expiresAt };
    const authorized = bound
      ? await access(database, principal, ticket.channel_id)
      : await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    if (!bound) return { kind: "forbidden" } as const;
    await database
      .deleteFrom("socket_tickets")
      .where("ticket_hash", "=", ticketHash)
      .execute();
    const value = {
      connectionId: crypto.randomUUID(),
      userId: ticket.user_id,
      sessionId: ticket.session_id,
      channelId: ticket.channel_id,
      leaseExpiresAt: ticket.lease_expires_at,
    };
    const active = ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN);
    if (
      active.length >= 256 ||
      active.filter((socket) => attachment(socket)?.userId === value.userId)
        .length >= 8
    )
      return { kind: "forbidden" } as const;
    return {
      kind: "admitted",
      value,
      cursor: cursor(authorized.state, value.channelId),
    } as const;
  });
  if (admitted.kind !== "admitted") return outcomeResponse(admitted);
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  server.serializeAttachment(admitted.value);
  sendFrame(server, {
    type: "ready",
    connectionId: admitted.value.connectionId,
    cursor: admitted.cursor,
    leaseExpiresAt: admitted.value.leaseExpiresAt,
  });
  await scheduleAlarm(
    ctx.storage,
    socketCleanupWake(admitted.value.leaseExpiresAt),
  );
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "Sec-WebSocket-Protocol": "vaskel-v1" },
  });
}
/** Fresh HTTP authority extends only this still-live session's connection. */
export function renewSocket(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: RenewSocket,
): Promise<MessagingOutcome> {
  return ctx.storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const socket = ctx.getWebSockets().find((candidate) => {
      const value = attachment(candidate);
      return (
        candidate.readyState === WebSocket.OPEN &&
        value?.connectionId === input.connectionId &&
        value.channelId === input.channelId &&
        value.userId === principal.userId &&
        value.sessionId === principal.sessionId
      );
    });
    if (!socket) return { kind: "socket_unavailable" };
    const value = attachment(socket)!;
    if (value.leaseExpiresAt <= Date.now()) {
      closeSocket(socket, "lease_expired");
      return { kind: "socket_unavailable" };
    }
    const authorized = await access(database, principal, input.channelId);
    if (authorized.kind !== "authorized") {
      closeSocket(socket, "access_changed");
      return authorized;
    }
    // A reordered earlier renewal must not shorten newer accepted authority.
    const leaseExpiresAt = Math.max(
      value.leaseExpiresAt,
      Math.min(principal.expiresAt, Date.now() + SOCKET_LEASE_MS),
    );
    await scheduleAlarm(ctx.storage, socketCleanupWake(leaseExpiresAt));
    // The attachment is outside SQL rollback. Finish fallible work first and
    // recheck lifetimes after the awaits before synchronously publishing it.
    const expired = principalFailure(principal);
    if (expired) return expired;
    if (
      socket.readyState !== WebSocket.OPEN ||
      value.leaseExpiresAt <= Date.now()
    ) {
      closeSocket(socket, "lease_expired");
      return { kind: "socket_unavailable" };
    }
    socket.serializeAttachment({ ...value, leaseExpiresAt });
    return {
      kind: "socket_renewed",
      connectionId: value.connectionId,
      leaseExpiresAt,
    };
  });
}

/** Commands stay on HTTP; socket inputs are exact, bounded control frames. */
export async function socketMessage(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  socket: WebSocket,
  message: string | ArrayBuffer,
  lastTyping: WeakMap<WebSocket, number>,
) {
  if (message !== '{"type":"reconcile"}' && message !== '{"type":"typing"}') {
    socket.close(1008, "Unsupported frame");
    return;
  }
  await ctx.storage.transaction(async () => {
    const admitted = await authorizeSocket(
      database,
      socket,
      attachment(socket),
    );
    if (!admitted) return;
    const { value, authorized } = admitted;
    if (message === '{"type":"reconcile"}') {
      sendFrame(socket, {
        type: "reconcile",
        cursor: cursor(authorized.state, value.channelId),
      });
      return;
    }
    const now = Date.now();
    const previous = lastTyping.get(socket);
    if (previous !== undefined && now - previous < 3_000) return;
    if (await newSendFailure(database, authorized.state)) return;
    // This throttle intentionally disappears on hibernation; typing is never stored.
    lastTyping.set(socket, now);
    for await (const recipient of authorizedSockets(
      ctx,
      database,
      (target) =>
        target.channelId === value.channelId && target.userId !== value.userId,
    )) {
      try {
        sendFrame(recipient.socket, {
          type: "typing",
          channelId: value.channelId,
          userId: value.userId,
          expiresAt: now + 6_000,
        });
      } catch {
        recipient.socket.close(1011, "Reconnect required");
      }
    }
  });
}
export async function reevaluateSockets(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
) {
  await ctx.storage.transaction(async () => {
    // Authorizing every socket closes the expired and revoked ones; nothing is sent.
    for await (const admitted of authorizedSockets(ctx, database))
      void admitted;
  });
}
export async function broadcastCommit(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  receipt: Receipt,
) {
  await ctx.storage.transaction(async () => {
    const event = await database
      .selectFrom("events")
      .selectAll()
      .where("sequence", "=", receipt.sequence)
      .executeTakeFirst();
    if (!event || event.previous_sequence === null) return;
    const message = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", receipt.messageId)
      .executeTakeFirst();
    if (!message) return;
    const readerIds = ctx.getWebSockets().flatMap((socket) => {
      const value = attachment(socket);
      return value?.channelId === event.channel_id ? [value.userId] : [];
    });
    const messages = await materializeForReaders(database, message, readerIds);
    for await (const { socket, value, state } of authorizedSockets(
      ctx,
      database,
      (target) => target.channelId === event.channel_id,
    )) {
      try {
        sendFrame(socket, {
          type: "committed",
          previous: event.previous_sequence,
          replayFloor: state.replay_floor,
          event: {
            sequence: event.sequence,
            operation: event.operation,
            message: messages.get(value.userId)!,
          },
          cursor: cursor(state, value.channelId, event.sequence),
        });
      } catch {
        socket.close(1011, "Replay required");
      }
    }
  });
}
export async function broadcastRead(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  channelId: string,
  sequence: number,
) {
  await ctx.storage.transaction(async () => {
    for await (const { socket } of authorizedSockets(
      ctx,
      database,
      (value) =>
        value.userId === principal.userId && value.channelId === channelId,
    )) {
      try {
        sendFrame(socket, { type: "read_updated", channelId, sequence });
      } catch {
        socket.close(1011, "Reconnect required");
      }
    }
  });
}

/** Invalidation only: no directed rule or read-access change is broadcast to the pair. */
export async function broadcastDmPolicy(
  ctx: DurableObjectState,
  database: Kysely<OwnerDatabase>,
) {
  await ctx.storage.transaction(async () => {
    for await (const { socket } of authorizedSockets(ctx, database)) {
      try {
        sendFrame(socket, { type: "dm_policy_changed" });
      } catch {
        socket.close(1011, "Reconnect required");
      }
    }
  });
}
