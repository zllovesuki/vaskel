import PartySocket from "partysocket/ws";
import {
  SOCKET_READY_WAIT_MS,
  watchSocket,
  type SocketWatch,
} from "./socket-liveness";

/** PartySocket owns transport retries; the application owns admission and leases. */
export function connectTicketSocket({
  path,
  protocol,
  ticket,
  active,
  status,
  onError,
  onMessage,
  onResume,
  ping,
  leaseMarginMs,
  renew,
}: {
  path: string;
  protocol: string;
  ticket: (signal: AbortSignal) => Promise<string>;
  active: () => boolean;
  status: (value: "reconnecting" | "offline") => void;
  onError: (error: unknown) => void;
  onMessage: (event: MessageEvent<string>) => void;
  onResume?: () => void;
  ping: string;
  leaseMarginMs: number;
  renew?: (
    connectionId: string,
    signal: AbortSignal,
  ) => Promise<{
    connectionId: string;
    leaseExpiresAt: number;
  } | null>;
}) {
  let socket: PartySocket | undefined;
  let transport: WebSocket | undefined;
  let abort: AbortController | undefined;
  let watch: SocketWatch | undefined;
  let connectionId: string | undefined;
  let renewal: AbortController | undefined;
  let disposed = false;
  let receiving = false;
  let generation = 0;
  const current = () => !disposed && active();
  function clearWatch() {
    renewal?.abort();
    renewal = undefined;
    connectionId = undefined;
    watch?.dispose();
    watch = undefined;
  }
  function retire() {
    generation++;
    receiving = false;
    abort?.abort();
    clearWatch();
    const previous = socket;
    socket = undefined;
    transport = undefined;
    previous?.close();
  }
  function start() {
    if (!current()) return;
    if (!navigator.onLine) {
      status("offline");
      return;
    }
    const lifetime = ++generation;
    const live = () => current() && lifetime === generation;
    const url = new URL(path, location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const opened = new PartySocket(
      url.toString(),
      async () => {
        // PartySocket's delayed provider can still run after close(). Do not
        // issue a private request for an obsolete or explicitly offline owner.
        if (!live() || !navigator.onLine) {
          opened.close();
          throw new DOMException("Socket admission canceled", "AbortError");
        }
        clearWatch();
        abort?.abort();
        const admission = new AbortController();
        abort = admission;
        try {
          const value = await ticket(admission.signal);
          if (!live() || admission.signal.aborted || !navigator.onLine) {
            opened.close();
            throw new DOMException("Socket admission canceled", "AbortError");
          }
          watch = watchSocket({
            socket: opened,
            ping,
            leaseMarginMs,
            current: live,
            expired: (reason) => (reason === "lease" ? reconnect() : retry()),
            ...(renew ? { renew: () => void renewCurrent() } : {}),
          });
          receiving = true;
          return [protocol, `vaskel-ticket.${value}`];
        } catch (error) {
          if (live() && !admission.signal.aborted) onError(error);
          // Rejection reaches PartySocket 1.3's unlock/error/retry path. Returning
          // empty protocols would instead attempt an unauthenticated upgrade.
          throw error;
        }
      },
      {
        // Public reconnect() resets PartySocket's retry counter. Capturing the
        // native close capability lets application failures enter its ordinary
        // close/backoff path instead, without another retry timer or scheduler.
        WebSocket: class extends WebSocket {
          constructor(url: string, protocols?: string | string[]) {
            super(url, protocols);
            transport = this;
          }
        },
        maxEnqueuedMessages: 0,
        minReconnectionDelay: 700 + Math.random() * 400,
        maxReconnectionDelay: 15_000,
        reconnectionDelayGrowFactor: 2,
        connectionTimeout: SOCKET_READY_WAIT_MS,
      },
    );
    socket = opened;
    const lost = () => {
      if (!live()) return;
      receiving = false;
      clearWatch();
      status(navigator.onLine ? "reconnecting" : "offline");
    };
    opened.onclose = lost;
    opened.onerror = lost;
    opened.onmessage = (event: MessageEvent<string>) => {
      if (live() && receiving) onMessage(event);
    };
  }
  async function renewCurrent() {
    const observed = watch;
    const id = connectionId;
    if (!renew || !observed || !id || renewal || !current()) return;
    const request = new AbortController();
    renewal = request;
    const live = () =>
      current() && watch === observed && !request.signal.aborted;
    try {
      const result = await renew(id, request.signal);
      if (!live()) return;
      if (!result || result.connectionId !== id) {
        reconnect();
        return;
      }
      observed.renewLease(result.leaseExpiresAt);
    } catch (error) {
      if (!live()) return;
      onError(error);
      if (live()) retry();
    } finally {
      if (renewal === request) renewal = undefined;
    }
  }
  function retry() {
    if (!current()) return;
    receiving = false;
    clearWatch();
    status(navigator.onLine ? "reconnecting" : "offline");
    transport?.close(4000, "Application socket retry");
  }
  function reconnect() {
    if (!current()) return;
    // Never reopen a closed PartySocket: reconnect() clears its close fence
    // even while an old async protocols provider is still settling.
    retire();
    status(navigator.onLine ? "reconnecting" : "offline");
    start();
  }
  const offline = () => {
    if (!current()) return;
    retire();
    status("offline");
  };
  const page = typeof document === "undefined" ? undefined : document;
  const visible = () => {
    if (page?.visibilityState !== "visible" || !current() || !navigator.onLine)
      return;
    if (!socket || socket.readyState !== PartySocket.OPEN) reconnect();
    else watch?.check();
    onResume?.();
  };
  window.addEventListener("online", reconnect);
  window.addEventListener("offline", offline);
  page?.addEventListener("visibilitychange", visible);
  start();
  return {
    reconnect,
    retry,
    received: (pong: boolean) => watch?.received(pong),
    acceptReady(expiresAt: number, id?: string) {
      if (renew && !id) {
        retry();
        return false;
      }
      connectionId = id;
      return watch?.acceptReady(expiresAt) ?? false;
    },
    isReady: () => watch?.isReady() ?? false,
    send(data: string) {
      if (!current() || !watch?.isReady()) return false;
      return socket?.send(data) ?? false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retire();
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", offline);
      page?.removeEventListener("visibilitychange", visible);
    },
  };
}
