import { fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { message } from "@/client/features/i18n/messages";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AckMediaRequestSchema,
  AnswerMediaRequestSchema,
  HeartbeatMediaRequestSchema,
  ModerateMediaRequestSchema,
  SubscribeMediaRequestSchema,
  type MediaOutcome,
} from "@vaskel/contracts/media";
import { IntentStore } from "@/client/features/media/intent";
import { MediaSession } from "@/client/features/media/session";
import {
  room,
  handle,
  publication,
  participant,
  snapshot,
  flush,
  wireResponse,
  FakeTrack,
  FakeStream,
} from "@tests/helpers/media";
import { browser, idle, connected } from "@tests/helpers/media-controller";

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("controller lifecycle", () => {
  it("submits the displayed participant version and refreshes a local moderation conflict without leaving", async () => {
    vi.useFakeTimers();
    let controlVersion = 2;
    const { controller, peers, calls } = await connected(
      (path, body) => {
        if (path === "heartbeat")
          return wireResponse({
            kind: "heartbeat",
            expiresAt: Date.now() + 30_000,
            snapshot: {
              ...snapshot(),
              revision: 99,
              participants: [
                participant("self"),
                { ...participant("peer"), controlVersion },
              ],
            },
          });
        if (path === "moderate") {
          expect(ModerateMediaRequestSchema.parse(body)).toMatchObject({
            userId: "peer",
            participantGeneration: 1,
            expectedControlVersion: 2,
          });
          return wireResponse({ kind: "moderation_changed" }, 409);
        }
      },
      true,
      true,
    );
    const api = await import("@/client/api/client");
    const failed = vi.fn();
    const uninstall = api.installRequestAccess({
      begin: () => ({ current: () => true, accountId: "self" }),
      failed,
    });
    try {
      await controller.refreshRoom();
      const shown = controller
        .getSnapshot()
        .session!.snapshot.participants.find((p) => p.userId === "peer")!;
      controlVersion = 3;
      await controller.refreshRoom();
      await controller.moderate(shown, "mute", true);
      expect(controller.getSnapshot()).toMatchObject({
        phase: "active",
        error: message("media.moderationChanged"),
      });
      expect(calls.filter((call) => call.path === "moderate")).toHaveLength(1);
      expect(
        calls.some((call) => call.path === "leave" || call.path === "resume"),
      ).toBe(false);
      expect(peers.every((peer) => !peer.closed)).toBe(true);
      expect(failed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "moderation_changed" }),
        expect.objectContaining({ authority: "media" }),
      );
    } finally {
      uninstall();
      controller.dispose();
    }
  });

  it("retains the verified handle when heartbeat reports an operational close", async () => {
    vi.useFakeTimers();
    const { controller, store, peers, calls } = await connected(
      (path, body) => {
        if (path === "heartbeat") {
          expect(HeartbeatMediaRequestSchema.parse(body).handle).toEqual(
            handle,
          );
          return wireResponse(
            {
              kind: "recovery_required",
              handle,
              reason: "lease_expired",
            },
            409,
          );
        }
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", room });
    expect(store.read()?.handle).toEqual(handle);
    expect(store.read()?.pending).toBeNull();
    expect(peers.every((peer) => peer.closed)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((call) => call.path === "heartbeat")).toHaveLength(1);
    expect(calls.some((call) => call.path === "resume")).toBe(false);
    await controller.leave();
    controller.dispose();
  });

  it.each([
    { kind: "participation_ended", generation: 1, reason: "removed" },
    {
      kind: "participation_ended",
      generation: 1,
      reason: "permission_revoked",
    },
    { kind: "stale_generation", currentGeneration: 2 },
    { kind: "forbidden" },
  ] satisfies MediaOutcome[])(
    "clears inherited recovery for authoritative $kind $reason",
    async (outcome) => {
      vi.useFakeTimers();
      const { controller, store, peers, calls } = await connected((path) =>
        path === "heartbeat"
          ? wireResponse(outcome, outcome.kind === "forbidden" ? 403 : 409)
          : undefined,
      );
      const api = await import("@/client/api/client");
      const accessFailure = vi.fn();
      const removeAccess = api.installRequestAccess({
        begin: () => ({
          current: () => true,
          accountId: "self",
        }),
        failed: accessFailure,
      });
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(store.read()).toBeNull();
        expect(controller.getSnapshot()).toMatchObject({
          phase: "error",
          room: null,
        });
        expect(peers.every((peer) => peer.closed)).toBe(true);
        expect(accessFailure).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ code: outcome.kind }),
          expect.objectContaining({ authority: "media" }),
        );
        await controller.resume();
        expect(calls.some((call) => call.path === "resume")).toBe(false);
      } finally {
        controller.dispose();
        removeAccess();
      }
    },
  );

  it("keeps the roster and peers through a failed refresh and repairs a missed hint on the heartbeat", async () => {
    vi.useFakeTimers();
    let disconnected = true;
    const next = {
      ...snapshot(),
      revision: 3,
      participants: [participant("self")],
    };
    const { controller, store, peers, calls } = await connected((path) => {
      if (path === "heartbeat") {
        if (disconnected) throw new TypeError("Network interrupted");
        return wireResponse({
          kind: "heartbeat",
          expiresAt: Date.now() + 30_000,
          snapshot: next,
        });
      }
    });
    for (const peer of peers) peer.connect();
    const before = controller.getSnapshot();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls.map((call) => call.path)).toEqual(["status", "join"]);
    await controller.refreshRoom(); // Reconnected inbox requests the same participation.
    expect(controller.getSnapshot()).toMatchObject({
      phase: "reconnecting",
      session: before.session,
      joinedAt: before.joinedAt,
    });
    expect(store.read()?.handle).toEqual(handle);
    expect(peers.every((peer) => !peer.closed)).toBe(true);
    controller.setMediaHidden("peer", true);
    expect(controller.getSnapshot().session).not.toBe(before.session);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "reconnecting",
      session: before.session,
      hiddenUserIds: ["peer"],
      joinedAt: before.joinedAt,
      error: message("media.reconnectingNotice"),
    });
    disconnected = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      session: { snapshot: next },
      joinedAt: before.joinedAt,
    });
    expect(
      calls.some((call) => call.path === "resume" || call.path === "snapshot"),
    ).toBe(false);
    await controller.leave();
    controller.dispose();
  });

  it("coalesces call notices and keeps a trailing read when state changes during a refresh", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    let reads = 0;
    const next = {
      ...snapshot(),
      revision: 2,
      participants: [participant("self")],
    };
    const { controller, calls } = await connected((path) => {
      if (path === "heartbeat")
        return ++reads === 1
          ? pending.promise
          : wireResponse({
              kind: "heartbeat",
              expiresAt: Date.now() + 30_000,
              snapshot: next,
            });
    });
    await controller.refreshRoom({ ...room, channelId: "elsewhere" });
    expect(reads).toBe(0);
    const refresh = controller.refreshRoom(room);
    void controller.refreshRoom(room);
    void controller.refreshRoom();
    await vi.waitFor(() => expect(reads).toBe(1));
    pending.resolve(
      wireResponse({
        kind: "heartbeat",
        expiresAt: Date.now() + 30_000,
        snapshot: snapshot(),
      }),
    );
    await refresh;
    expect(reads).toBe(2);
    expect(controller.getSnapshot().session!.snapshot).toEqual(next);
    await controller.leave();
    await controller.refreshRoom();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(2);
    expect(calls.some((call) => call.path === "snapshot")).toBe(false);
    controller.dispose();
  });

  it("keeps a disconnected peer reconnecting across successful heartbeats", async () => {
    vi.useFakeTimers();
    const { controller, peers, calls } = await connected();
    peers[0]!.connect("disconnected");
    expect(controller.getSnapshot().phase).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.some((call) => call.path === "heartbeat")).toBe(true);
    expect(controller.getSnapshot().phase).toBe("reconnecting");
    peers[0]!.connect();
    expect(controller.getSnapshot().phase).toBe("active");
    await controller.leave();
    controller.dispose();
  });

  it.each([false, true])(
    "ignores a late status failure after Leave (replacement: %s)",
    async (replace) => {
      const { storage, peers } = browser();
      const store = new IntentStore("https://vaskel.test", "self", storage);
      store.setMuted(true);
      const status = deferred<Response>();
      let statuses = 0;
      vi.stubGlobal("fetch", async (httpInput: RequestInfo | URL) => {
        const httpRequest = fetchRequest(httpInput);
        const path = new URL(httpRequest.url).pathname;

        if (path.endsWith("/status")) {
          statuses++;
          return statuses === 1 ? status.promise : wireResponse(idle);
        }
        if (path.endsWith("/join"))
          return wireResponse({
            kind: "joined",
            handle,
            generation: 1,
            producerVersion: 0,
            consumerVersion: 0,
            snapshot: snapshot(),
          });
        if (path.endsWith("/leave"))
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
      const joining = controller.join(room, "Lounge");
      await flush();
      await controller.leave();
      if (replace) await controller.join(room, "New call");
      const current = controller.getSnapshot();
      const intent = store.read();
      status.resolve(wireResponse({ kind: "forbidden" }));
      await joining;
      expect(controller.getSnapshot()).toEqual(current);
      expect(store.read()).toEqual(intent);
      expect(peers).toHaveLength(replace ? 2 : 0);
      await controller.leave();
      controller.dispose();
    },
  );

  it("keeps Leave bound to its original account after the surrounding account was closed", async () => {
    const { controller } = await connected();
    const api = await import("@/client/api/client");
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: "self",
      }),
      failed: vi.fn(),
    });
    const fetcher = vi.fn<
      (path: string, init: RequestInit) => Promise<Response>
    >(async () =>
      wireResponse({ kind: "left", generation: 1, cleanupPending: false }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      controller.setNetworkAllowed(false);
      await controller.leave();
      const [path, init] = fetcher.mock.calls[0]!;
      expect(new URL(fetchRequest(path, init).url).pathname).toBe(
        "/api/media/leave",
      );
      expect(new Headers(init.headers).get(EXPECTED_ACCOUNT_HEADER)).toBe(
        "self",
      );
      expect(controller.getSnapshot().phase).toBe("idle");
    } finally {
      controller.dispose();
      cleanup();
    }
  });

  it.each(["ack", "answer"] as const)(
    "disposes allocated media without accepting completion when %s requires recovery",
    async (completion) => {
      vi.useFakeTimers();
      const rpc = vi.spyOn(MediaSession.prototype, "rpc");
      const response = deferred<Response>();
      const microphone = publication(
        "22222222-2222-4222-8222-222222222222",
        "microphone",
      );
      const { controller, store, peers, calls } = await connected(
        (path, body) => {
          if (path === completion) {
            const command =
              completion === "ack"
                ? AckMediaRequestSchema.parse(body)
                : AnswerMediaRequestSchema.parse(body);
            expect(command.handle).toEqual(handle);
            expect(command.expectedSessionVersion).toBe(1);
            return response.promise;
          }
          if (completion === "answer" && path === "heartbeat")
            return wireResponse({
              kind: "heartbeat",
              expiresAt: Date.now() + 30_000,
              snapshot: { ...snapshot([microphone]), revision: 2 },
            });
          if (path === "subscribe") {
            const command = SubscribeMediaRequestSchema.parse(body);
            expect(command.expectedSessionVersion).toBe(0);
            return wireResponse({
              kind: "negotiation",
              operationId: command.operationId,
              sessionVersion: 1,
              phase: "awaiting_answer",
              sessionDescription: { type: "offer", sdp: "offer" },
              publications: [],
              subscriptions: [{ publication: microphone, mid: "0" }],
              deadline: Date.now() + 15_000,
            });
          }
        },
      );
      const capture = new FakeTrack("video");
      const received = new FakeTrack();
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: async () =>
            new FakeStream([capture as unknown as MediaStreamTrack]),
        },
      });
      const publishing = controller.startDevice("camera");
      await flush();
      if (completion === "answer") {
        await publishing;
        await vi.advanceTimersByTimeAsync(10_000);
        const event = new Event("track");
        Object.defineProperties(event, {
          track: { value: received },
          transceiver: { value: { mid: "0" } },
        });
        peers[1]!.dispatchEvent(event);
        expect(controller.getSnapshot().session!.remote).toHaveLength(1);
      }
      await vi.waitFor(() => expect(calls.at(-1)?.path).toBe(completion));
      expect(capture.stopped).toBe(0);
      const session =
        rpc.mock.contexts[
          rpc.mock.calls.findIndex(([path]) => path === completion)
        ];
      expect(session).toBeInstanceOf(MediaSession);
      response.resolve(
        wireResponse({
          kind: "recovery_required",
          handle,
          reason: "transport_closed",
        }),
      );
      await publishing;
      await flush();
      expect(controller.getSnapshot()).toMatchObject({
        phase: "error",
        room,
        session: null,
        pendingSources: [],
      });
      expect(store.read()).toMatchObject({ handle, pending: null });
      expect(peers.every((peer) => peer.closed)).toBe(true);
      expect(capture.stopped).toBeGreaterThan(0);
      if (completion === "answer") expect(received.stopped).toBe(1);
      // A recovery disposition cannot commit either negotiated session version.
      expect(session).toHaveProperty(
        "producerVersion",
        completion === "ack" ? 0 : 1,
      );
      expect(session).toHaveProperty("consumerVersion", 0);
      const requests = calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toHaveLength(requests);
      expect(calls.some((call) => call.path === "resume")).toBe(false);
      await controller.leave();
      controller.dispose();
    },
  );

  it("consumes terminal removal through explicit Resume after a control transport outage", async () => {
    vi.useFakeTimers();
    const { controller, store, calls } = await connected((path) => {
      if (path === "heartbeat") throw new TypeError("Heartbeat unavailable");
      if (path === "resume")
        return wireResponse({
          kind: "participation_ended",
          generation: 1,
          reason: "removed",
        });
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.read()?.handle).toEqual(handle);
    expect(calls.some((call) => call.path === "resume")).toBe(false);
    await controller.resume();
    expect(store.read()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      room: null,
    });
    expect(controller.getSnapshot().error).toEqual(message("media.removed"));
    await controller.resume();
    expect(calls.filter((call) => call.path === "resume")).toHaveLength(1);
    controller.dispose();
  });

  it("keeps the displayed roster until the owned refresh reports terminal removal", async () => {
    vi.useFakeTimers();
    const status = deferred<Response>();
    const { controller, store, peers, calls } = await connected(
      (path, body) => {
        if (path === "heartbeat") {
          expect(HeartbeatMediaRequestSchema.parse(body).handle).toEqual(
            handle,
          );
          return status.promise;
        }
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peers.every((peer) => !peer.closed)).toBe(true);
    expect(store.read()?.handle).toEqual(handle);
    expect(calls.map((call) => call.path)).toEqual([
      "status",
      "join",
      "heartbeat",
    ]);
    status.resolve(
      wireResponse({
        kind: "participation_ended",
        generation: 1,
        reason: "removed",
      }),
    );
    await flush();
    expect(store.read()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      room: null,
    });
    expect(controller.getSnapshot().error).toEqual(message("media.removed"));
    await controller.resume();
    expect(calls.some((call) => call.path === "resume")).toBe(false);
    controller.dispose();
  });

  it("ignores a delayed owned refresh after explicit Leave and replacement", async () => {
    vi.useFakeTimers();
    const status = deferred<Response>();
    let joins = 0;
    const replacement = {
      ...handle,
      accountGeneration: 2,
      deviceToken: "b".repeat(64),
    };
    const { controller, store, peers } = await connected((path) => {
      if (path === "heartbeat") return status.promise;
      if (path === "join" && ++joins > 1)
        return wireResponse({
          kind: "joined",
          handle: replacement,
          generation: 2,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: {
            ...snapshot(),
            participants: [{ ...participant("self"), generation: 2 }],
          },
        });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.leave();
    await controller.join(room, "Replacement");
    const current = controller.getSnapshot();
    status.resolve(
      wireResponse({
        kind: "participation_ended",
        generation: 1,
        reason: "removed",
      }),
    );
    await flush();
    expect(controller.getSnapshot()).toEqual(current);
    expect(store.read()?.handle).toEqual(replacement);
    expect(peers.slice(2).every((peer) => !peer.closed)).toBe(true);
    await controller.leave();
    controller.dispose();
  });

  it.each([
    { kind: "action_restricted", restriction: "deafen" },
    { kind: "publication_unavailable" },
  ] satisfies MediaOutcome[])(
    "keeps subscription $kind action scoped without an extra snapshot query",
    async (outcome) => {
      vi.useFakeTimers();
      const microphone = publication(
        "22222222-2222-4222-8222-222222222222",
        "microphone",
      );
      const { controller, store, peers, calls } = await connected((path) => {
        if (path === "heartbeat")
          return wireResponse({
            kind: "heartbeat",
            expiresAt: Date.now() + 30_000,
            snapshot: snapshot([microphone]),
          });
        if (path === "subscribe") return wireResponse(outcome);
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.map((call) => call.path)).toEqual([
        "status",
        "join",
        "heartbeat",
        "subscribe",
      ]);
      expect(controller.getSnapshot().phase).toBe("active");
      expect(store.read()?.handle).toEqual(handle);
      expect(peers.every((peer) => !peer.closed)).toBe(true);
      await controller.leave();
      controller.dispose();
    },
  );
});
