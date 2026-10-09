import { rawRoutes } from "@vaskel/contracts/api";
import { apiFailure } from "@/client/api/errors";
import type { QueryClient } from "@tanstack/react-query";
import { type AccountEventEffects } from "./apply";
import { api } from "@/client/api/contract";

import {
  ACCOUNT_EVENTS_PING,
  AccountEventFrameSchema,
} from "@vaskel/contracts/account-events";

import { connectTicketSocket } from "@/client/api/ticket-socket";
import { applyAccountEvent, NoticeMemory } from "./apply";

export type AccountEventsStatus =
  "connecting" | "connected" | "reconnecting" | "offline" | "revoked";

/**
 * One account's hint socket. The Worker hands out a single-use ticket after a
 * primary-backed session check; the actor consumes it during the upgrade and
 * closes the socket with `revoked` or `lease_expired` when the session or the
 * lease ends. The socket carries nothing inbound except the unbilled ping.
 */
export function connectAccountEvents({
  client,
  userId,
  status,
  onRevoked,
  effects,
  memory = new NoticeMemory(),
}: {
  client: QueryClient;
  userId: string;
  status: (value: AccountEventsStatus) => void;
  onRevoked: () => void;
  effects: AccountEventEffects;
  memory?: NoticeMemory;
}) {
  let disposed = false;
  let revoked = false;
  const active = () => !disposed && !revoked;
  function revoke() {
    if (!active()) return;
    revoked = true;
    memory.dispose();
    socket.dispose();
    status("revoked");
    onRevoked();
  }
  const socket = connectTicketSocket({
    path: rawRoutes.accountSocket.path,
    protocol: "vaskel-account-events-v1",
    ticket: async (signal) =>
      (await api.accountEventTicket(undefined, { signal })).ticket,
    active,
    status,
    onResume: memory.resume,
    onError: (error) => {
      if (apiFailure(error) && apiFailure(error)?.code === "unauthenticated")
        revoke();
    },
    ping: ACCOUNT_EVENTS_PING,
    leaseMarginMs: 30_000,
    onMessage: (event) => {
      let parsed;
      try {
        parsed = AccountEventFrameSchema.safeParse(JSON.parse(event.data));
      } catch {
        socket.retry();
        return;
      }
      if (!parsed.success) {
        socket.retry();
        return;
      }
      const notice = parsed.data;
      socket.received(notice.type === "pong");
      if (notice.type === "pong") return;
      if (notice.type === "revoked") {
        revoke();
        return;
      }
      if (notice.type === "lease_expired") {
        socket.reconnect();
        return;
      }
      if (notice.type === "ready") {
        if (!socket.acceptReady(notice.leaseExpiresAt)) return;
        status("connected");
      }
      applyAccountEvent(client, userId, notice, memory, effects);
    },
  });
  return {
    dispose() {
      memory.dispose();
      disposed = true;
      socket.dispose();
    },
  };
}
