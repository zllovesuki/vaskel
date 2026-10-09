import { fetchRequest } from "@tests/helpers/http";
import { vi } from "vitest";
import {
  AckMediaRequestSchema,
  HeartbeatMediaRequestSchema,
  JoinMediaRequestSchema,
  PublishMediaRequestSchema,
} from "@vaskel/contracts/media";
import { IntentStore } from "@/client/features/media/intent";
import {
  room,
  handle,
  snapshot,
  wireResponse,
  FakePeer,
} from "@tests/helpers/media";

export function browser() {
  const peers: FakePeer[] = [];
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("window", {
    location: { origin: "https://vaskel.test" },
    sessionStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends FakePeer {
      constructor() {
        super();
        peers.push(this);
      }
    },
  );
  return { values, storage, peers };
}

export const idle = {
  kind: "media_status" as const,
  generation: 0,
  admission: { kind: "available" as const },
};

export async function connected(
  respond?: (
    path: string,
    body: unknown,
  ) => Response | Promise<Response> | undefined,
  muted = true,
  canModerate = false,
) {
  const env = browser();
  const store = new IntentStore("https://vaskel.test", "self", env.storage);
  if (muted) store.setMuted(true);
  const calls: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init: RequestInit) => {
    const request = fetchRequest(url, init);
    const path = new URL(request.url).pathname.slice("/api/media/".length);
    const body: unknown =
      request.method === "GET" ? undefined : await request.json();
    calls.push({ path, body });
    const response = respond?.(path, body);
    if (response) return response;
    if (path === "status") return wireResponse(idle);
    if (path === "join") {
      JoinMediaRequestSchema.parse(body);
      return wireResponse({
        kind: "joined",
        handle,
        generation: 1,
        producerVersion: 0,
        consumerVersion: 0,
        snapshot: snapshot(),
      });
    }
    if (path === "heartbeat") {
      HeartbeatMediaRequestSchema.parse(body);
      return wireResponse({
        kind: "heartbeat",
        expiresAt: Date.now() + 30_000,
        snapshot: snapshot(),
      });
    }
    if (path === "publish") {
      const command = PublishMediaRequestSchema.parse(body);
      return wireResponse({
        kind: "negotiation",
        operationId: command.operationId,
        sessionVersion: 1,
        phase: "awaiting_apply",
        sessionDescription: { type: "answer", sdp: "answer" },
        publications: [],
        subscriptions: [],
        deadline: Date.now() + 15_000,
      });
    }
    if (path === "ack" || path === "unpublish") {
      const command =
        path === "ack"
          ? AckMediaRequestSchema.parse(body)
          : (body as { operationId: string });
      return wireResponse({
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: 1,
        revision: 2,
      });
    }
    if (path === "leave")
      return wireResponse({
        kind: "left",
        generation: 1,
        cleanupPending: false,
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  const { MediaController } =
    await import("@/client/features/media/controller");
  const controller = new MediaController("self", "https://vaskel.test");
  await controller.join(room, "Lounge", canModerate);
  return { ...env, controller, store, calls };
}
