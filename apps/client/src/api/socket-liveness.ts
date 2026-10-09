/** Transport deadlines are independent of application replay and authorization. */
export const SOCKET_READY_WAIT_MS = 10_000;
export const SOCKET_PING_INTERVAL_MS = 25_000;
export const SOCKET_REPLY_WAIT_MS = 10_000;

export type SocketExpiry = "ready" | "heartbeat" | "lease";

export function watchSocket({
  socket,
  ping,
  leaseMarginMs,
  current,
  expired,
  renew,
}: {
  socket: { readonly readyState: number; send(data: string): void };
  ping: string;
  leaseMarginMs: number;
  current: () => boolean;
  expired: (reason: SocketExpiry) => void;
  renew?: () => void;
}) {
  let stopped = false;
  let ready = false;
  let lastReceivedAt = Date.now();
  let leaseDeadline = Infinity;
  let replyDeadline = Infinity;
  const readyDeadline = Date.now() + SOCKET_READY_WAIT_MS;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalDeadline = Infinity;
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  const readyTimer = setTimeout(() => fail("ready"), SOCKET_READY_WAIT_MS);
  function dispose() {
    stopped = true;
    clearTimeout(readyTimer);
    clearTimeout(leaseTimer);
    clearTimeout(renewalTimer);
    clearTimeout(replyTimer);
    clearInterval(pingTimer);
  }
  function fail(reason: SocketExpiry) {
    if (stopped || !current()) return;
    dispose();
    expired(reason);
  }
  function check() {
    if (stopped || !current()) return false;
    const now = Date.now();
    if (!ready && now >= readyDeadline) fail("ready");
    else if (now >= leaseDeadline) fail("lease");
    else if (
      now >= replyDeadline ||
      (ready &&
        now - lastReceivedAt >= SOCKET_PING_INTERVAL_MS + SOCKET_REPLY_WAIT_MS)
    )
      fail("heartbeat");
    if (!stopped && now >= renewalDeadline) {
      renewalDeadline = Infinity;
      clearTimeout(renewalTimer);
      renew?.();
    }
    return !stopped;
  }
  function scheduleLease(expiresAt: number) {
    clearTimeout(leaseTimer);
    clearTimeout(renewalTimer);
    // Very short session leases must not produce a tight renewal loop.
    const margin = Math.min(leaseMarginMs, (expiresAt - Date.now()) / 10);
    leaseDeadline = renew ? expiresAt : expiresAt - margin;
    leaseTimer = setTimeout(() => fail("lease"), leaseDeadline - Date.now());
    if (renew) {
      renewalDeadline = expiresAt - margin;
      renewalTimer = setTimeout(check, renewalDeadline - Date.now());
    }
  }
  return {
    /** Frames prove receive liveness; only pong acknowledges the sent ping. */
    received(pong: boolean) {
      if (stopped || !current()) return;
      lastReceivedAt = Date.now();
      if (pong) {
        replyDeadline = Infinity;
        clearTimeout(replyTimer);
      }
    },
    acceptReady(leaseExpiresAt: number) {
      if (stopped || !current()) return false;
      if (leaseExpiresAt <= Date.now()) {
        fail("lease");
        return false;
      }
      ready = true;
      lastReceivedAt = Date.now();
      clearTimeout(readyTimer);
      scheduleLease(leaseExpiresAt);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (!check()) return;
        if (socket.readyState !== WebSocket.OPEN) {
          fail("heartbeat");
          return;
        }
        try {
          socket.send(ping);
          replyDeadline = Date.now() + SOCKET_REPLY_WAIT_MS;
          clearTimeout(replyTimer);
          replyTimer = setTimeout(
            () => fail("heartbeat"),
            SOCKET_REPLY_WAIT_MS,
          );
        } catch {
          fail("heartbeat");
        }
      }, SOCKET_PING_INTERVAL_MS);
      return true;
    },
    /** HTTP authorization does not prove socket receive activity or acknowledge ping. */
    renewLease(expiresAt: number) {
      if (!check() || !ready) return false;
      // A session capped at its existing expiry cannot extend this socket.
      if (expiresAt > leaseDeadline) scheduleLease(expiresAt);
      return true;
    },
    isReady: () => check() && ready && socket.readyState === WebSocket.OPEN,
    check,
    dispose,
  };
}

export type SocketWatch = ReturnType<typeof watchSocket>;
