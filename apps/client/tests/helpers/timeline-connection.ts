import { QueryClient } from "@tanstack/react-query";
import { expect, vi } from "vitest";
import type { Message, OwnerScope } from "@vaskel/contracts/messaging";
import type { ApiError } from "@/client/api/client";
import type {
  ConnectionState,
  TypingFrame,
} from "@/client/features/chat/connection";
import { TimelineProjection } from "@/client/features/cache/timeline-projection";
import { latestTimeline } from "@/client/features/chat/reconcile";

export const owner = { kind: "server", id: "owner" } as const;

const connectionId = "00000000-0000-4000-8000-000000000001";

export const cursor = {
  owner,
  channelId: "general",
  generation: crypto.randomUUID(),
  sequence: 10,
};

export const key = ["private", "account", "timeline", "owner", "general"];

export const row: Message = {
  id: "recent",
  channelId: "general",
  authorId: "author",
  body: "Recent body",
  attachments: [],
  createdAt: 10,
  updatedAt: 10,
  deletedAt: null,
  reactions: [],
  mentions: [],
  createdSequence: 10,
  updatedSequence: 10,
  version: 1,
};

export const state = latestTimeline({
  messages: [row],
  cursor,
  nextBefore: 10,
  readSequence: 5,
});

let connectTimeline: typeof import("@/client/features/chat/connection").connectTimeline;

export let client: QueryClient;

export let restoreAccess: () => void;

export const disposals: (() => void)[] = [];

/** The account-events provider's registry: content hints arrive here after retirement. */
export const contentListeners = new Set<(owner: OwnerScope) => void>();

export function hintContent(hinted: OwnerScope = owner) {
  for (const listener of contentListeners) listener(hinted);
}

export function replay(sequence: number, hasMore = false) {
  return Response.json({
    kind: "replay",
    events: [],
    cursor: { ...cursor, sequence },
    highWater: sequence,
    hasMore,
  });
}

export function connection(
  extra: {
    projection?: TimelineProjection;
    status?: (value: ConnectionState) => void;
    onTyping?: (frame: TypingFrame) => void;
    onDenied?: (error: ApiError) => void;
  } = {},
) {
  const result = connectTimeline({
    client,
    key,
    owner,
    channelId: "general",
    userId: "account",
    onDenied: extra.onDenied ?? vi.fn(),
    subscribeContent: (listener) => {
      contentListeners.add(listener);
      return () => {
        contentListeners.delete(listener);
      };
    },
    status: extra.status ?? vi.fn(),
    ...(extra.projection ? { projection: extra.projection } : {}),
    ...(extra.onTyping ? { onTyping: extra.onTyping } : {}),
  });
  disposals.push(() => result.dispose());
  return result;
}

export class Socket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  constructor(readonly sockets: Socket[]) {
    super();
    sockets.push(this);
  }
  receive(event: MessageEvent<string>) {
    this.dispatchEvent(new MessageEvent("message", { data: event.data }));
  }
  send(data: string) {
    if (this.readyState !== Socket.OPEN) throw new Error("Socket is not open");
    this.sent.push(data);
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    queueMicrotask(() => {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    });
  }
}

/** Opens a live socket for the connection under test and returns its frames. */
export function liveSocket(ready = true) {
  const sockets: Socket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor() {
        super(sockets);
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          if (ready)
            this.receive({
              data: JSON.stringify({
                type: "ready",
                connectionId,
                cursor,
                leaseExpiresAt: Date.now() + 30_000,
              }),
            } as MessageEvent<string>);
        });
      }
      override send(data: string) {
        super.send(data);
        if (data === '{"type":"ping"}')
          queueMicrotask(() =>
            this.receive({ data: '{"type":"pong"}' } as MessageEvent<string>),
          );
      }
    },
  );
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", {
    origin: "https://vaskel.test",
    protocol: "https:",
  });
  return sockets;
}

export function ticketFetch(responses: () => Response | Promise<Response>) {
  return vi.fn(async (request: string | Request) => {
    const path =
      typeof request === "string" ? request : new URL(request.url).pathname;
    return path.endsWith("/socket-ticket")
      ? Response.json({
          kind: "socket_ticket",
          ticket: "ticket",
          expiresAt: 1_000,
          leaseExpiresAt: 2_000,
        })
      : path.endsWith("/socket-renew")
        ? Response.json({
            kind: "socket_renewed",
            connectionId,
            leaseExpiresAt: Date.now() + 30_000,
          })
        : responses();
  });
}

export function committed(
  sequence: number,
  previous: number,
  replayFloor: number,
  message: Message,
) {
  return JSON.stringify({
    type: "committed",
    cursor: { ...cursor, sequence },
    previous,
    replayFloor,
    event: { operation: "send", sequence, message },
  });
}
export async function setupTimeline() {
  vi.stubGlobal("window", {
    location: { origin: "https://vaskel.test" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("navigator", { onLine: false });
  const api = await import("@/client/api/client");
  ({ connectTimeline } = await import("@/client/features/chat/connection"));
  restoreAccess = api.installRequestAccess({
    begin: () => ({
      current: () => true,
      accountId: "account",
    }),
    failed: vi.fn(),
  });
  client = new QueryClient();
  client.setQueryData(key, state);
}

export async function connected(fetcher: ReturnType<typeof ticketFetch>) {
  const sockets = liveSocket();
  vi.stubGlobal("fetch", fetcher);
  const status = vi.fn();
  const active = connection({ status });
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith("connected"));
  return { sockets, active, status };
}
