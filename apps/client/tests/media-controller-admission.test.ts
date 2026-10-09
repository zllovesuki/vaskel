import { fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { message } from "@/client/features/i18n/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JoinMediaRequestSchema,
  LeaveMediaRequestSchema,
  ResumeMediaRequestSchema,
  type MediaHandle,
} from "@vaskel/contracts/media";
import type { CallState } from "@/client/features/media/controller/state";
import { IntentStore } from "@/client/features/media/intent";
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
  it("publishes a complete session view during joining before marking membership active", async () => {
    const { storage, peers } = browser();
    const store = new IntentStore("https://vaskel.test", "self", storage);
    store.setMuted(true);
    vi.stubGlobal("fetch", async (httpInput: RequestInfo | URL) => {
      const httpRequest = fetchRequest(httpInput);
      const path = new URL(httpRequest.url).pathname;

      if (path.endsWith("/status")) return wireResponse(idle);
      if (path.endsWith("/join"))
        return wireResponse({
          kind: "joined",
          handle,
          generation: 1,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: snapshot(),
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    const { MediaController } =
      await import("@/client/features/media/controller");
    const controller = new MediaController("self", "https://vaskel.test");
    const states: CallState[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot()));
    try {
      await controller.join(room, "Lounge");
      const joining = states.filter((state) => state.phase === "joining");
      expect(joining[0]?.session).toBeNull();
      const admitted = joining.filter((state) => state.session !== null);
      expect(admitted.length).toBeGreaterThan(0);
      for (const state of admitted) {
        expect(state.session).toEqual({
          participantId: handle.participantId,
          snapshot: snapshot(),
          local: [],
          remote: [],
          selectedScreen: null,
        });
        expect(state.joinedAt).toBeNull();
      }
      expect(controller.getSnapshot()).toMatchObject({
        phase: "active",
        session: admitted[0]!.session,
        joinedAt: expect.any(Number),
      });
      // Admitted membership does not imply the new peers are connected.
      expect(peers.every((peer) => peer.connectionState === "new")).toBe(true);
    } finally {
      controller.dispose();
    }
  });

  it.each([false, true])(
    "leaves a pending Join with its exact command and ignores late acceptance (access paused: %s)",
    async (paused) => {
      const { storage, peers } = browser();
      const store = new IntentStore("https://vaskel.test", "self", storage);
      const accepted = deferred<Response>();
      const cleanup = deferred<Response>();
      let joinBody: unknown;
      let leaveBody: unknown;
      vi.stubGlobal(
        "fetch",
        async (httpInput: RequestInfo | URL, init: RequestInit) => {
          const httpRequest = fetchRequest(httpInput, init);
          const path = new URL(httpRequest.url).pathname;

          if (path.endsWith("/status")) return wireResponse(idle);
          const body: unknown = await httpRequest.json();
          if (path.endsWith("/join")) {
            joinBody = JoinMediaRequestSchema.parse(body);
            return accepted.promise;
          }
          if (path.endsWith("/leave")) {
            leaveBody = LeaveMediaRequestSchema.parse(body);
            expect(store.read()).toBeNull();
            return cleanup.promise;
          }
          throw new Error(`Unexpected request: ${path}`);
        },
      );
      const { MediaController } =
        await import("@/client/features/media/controller");
      const controller = new MediaController("self", "https://vaskel.test");
      const joining = controller.join(room, "Lounge");
      await flush();
      await vi.waitFor(() => expect(joinBody).toBeDefined());
      const retained = store.read()?.pending;
      expect(retained).toEqual({ path: "join", body: joinBody });
      if (paused) controller.setNetworkAllowed(false);
      const leaving = controller.leave();
      await vi.waitFor(() =>
        expect(leaveBody).toMatchObject({ pending: retained }),
      );
      expect(store.read()).toBeNull();
      expect(controller.getSnapshot().phase).toBe("idle");
      if (paused) controller.setNetworkAllowed(true);
      const command = JoinMediaRequestSchema.parse(joinBody);
      accepted.resolve(
        wireResponse({
          kind: "joined",
          handle: {
            ...handle,
            clientId: command.clientId,
            deviceToken: command.deviceToken,
          },
          generation: 1,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: snapshot(),
        }),
      );
      await joining;
      expect(controller.getSnapshot().phase).toBe("idle");
      expect(store.read()).toBeNull();
      expect(peers).toEqual([]);
      cleanup.resolve(
        wireResponse({ kind: "left", generation: 2, cleanupPending: false }),
      );
      await leaving;
      controller.dispose();
    },
  );

  it("persists and retries exactly the same join command after an ambiguous response", async () => {
    const { storage } = browser();
    const store = new IntentStore("https://vaskel.test", "self", storage);
    store.setMuted(true);
    const attempts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      async (httpInput: RequestInfo | URL, init: RequestInit) => {
        const httpRequest = fetchRequest(httpInput, init);
        const path = new URL(httpRequest.url).pathname;

        if (path.endsWith("/status")) return Response.json(idle);
        if (path.endsWith("/join")) {
          const body: unknown = await httpRequest.json();
          attempts.push(body);
          expect(store.read()?.pending?.body).toEqual(body);
          if (attempts.length === 1)
            throw new TypeError("Connection interrupted");
          return Response.json({
            kind: "joined",
            handle,
            generation: 1,
            producerVersion: 0,
            consumerVersion: 0,
            snapshot: snapshot(),
          });
        }
        if (path.endsWith("/leave"))
          return Response.json({
            kind: "left",
            generation: 1,
            cleanupPending: false,
          });
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    const { MediaController } =
      await import("@/client/features/media/controller");
    const controller = new MediaController("self", "https://vaskel.test");
    await controller.join(room, "Lounge");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(controller.getSnapshot().phase).toBe("active");
    await controller.leave();
    controller.dispose();
  });

  it.each([false, true])(
    "does not auto-resume copied capability in a new tab (access initially paused: %s)",
    async (paused) => {
      const { storage } = browser();
      const store = new IntentStore("https://vaskel.test", "self", storage);
      store.write({
        room,
        label: "Lounge",
        canModerate: false,
        handle,
        pending: null,
      });
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([
        { type: "navigate" } as unknown as PerformanceEntry,
      ]);
      const fetch = vi.fn(async () =>
        Response.json({
          kind: "media_configuration",
          configured: true,
          maxParticipants: 16,
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const { MediaController } =
        await import("@/client/features/media/controller");
      const controller = new MediaController(
        "self",
        "https://vaskel.test",
        !paused,
      );
      const release = controller.attach();
      if (paused) {
        await flush();
        expect(fetch).not.toHaveBeenCalled();
        expect(store.read()?.handle).toEqual(handle);
        controller.setNetworkAllowed(true);
      }
      await vi.waitFor(() => expect(store.read()).toBeNull());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().phase).toBe("idle");
      release();
      await Promise.resolve();
    },
  );

  it("holds media recovery and controls until revalidated access, then resumes only retained intent", async () => {
    vi.useFakeTimers();
    const resumed = { ...handle, accountGeneration: 2 };
    const { controller, store, peers, calls } = await connected(
      (path, body) => {
        if (path !== "resume") return;
        const command = ResumeMediaRequestSchema.parse(body);
        return wireResponse({
          kind: "joined",
          handle: { ...resumed, deviceToken: command.nextDeviceToken },
          generation: 2,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: {
            ...snapshot(),
            participants: [{ ...participant("self"), generation: 2 }],
          },
        });
      },
    );
    const camera = new FakeTrack("video");
    const capture = vi.fn(
      async () => new FakeStream([camera as unknown as MediaStreamTrack]),
    );
    vi.stubGlobal("navigator", {
      onLine: true,
      mediaDevices: { getUserMedia: capture },
    });
    await controller.startDevice("camera");
    controller.setNetworkAllowed(false);
    expect(camera.stopped).toBeGreaterThan(0);
    expect(peers.every((peer) => peer.closed)).toBe(true);
    expect(store.read()?.handle).toEqual(handle);
    expect(controller.getSnapshot().phase).toBe("error");
    const before = calls.length;
    // A browser online hint cannot restore authenticated media authority.
    for (const [event, callback] of vi.mocked(window.addEventListener).mock
      .calls)
      if (event === "online" && typeof callback === "function")
        callback(new Event("online"));
    await controller.resume();
    await controller.join(room, "Another join");
    await controller.startDevice("camera");
    controller.shareScreen();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(before);
    expect(capture).toHaveBeenCalledOnce();
    controller.setNetworkAllowed(true);
    await flush();
    expect(controller.getSnapshot().phase).toBe("active");
    expect(calls.slice(before).map((call) => call.path)).toEqual(["resume"]);
    expect(calls.at(-1)?.body).toMatchObject({ handle });
    expect(peers).toHaveLength(4);
    expect(peers.slice(2).every((peer) => !peer.closed)).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
    controller.setNetworkAllowed(false);
    await controller.leave();
    const afterLeave = calls.length;
    controller.setNetworkAllowed(true);
    await flush();
    expect(calls).toHaveLength(afterLeave);
    expect(store.read()).toBeNull();
    expect(controller.getSnapshot().phase).toBe("idle");
    controller.dispose();
  });

  it("refresh rotates and persists the resume token before retrying an ambiguous response", async () => {
    const { storage } = browser();
    const hiddenUserId = "33333333-3333-4333-8333-333333333333";
    const store = new IntentStore("https://vaskel.test", "self", storage);
    store.write({
      room,
      label: "Lounge",
      canModerate: false,
      hiddenUserIds: [hiddenUserId],
      handle,
      pending: null,
    });
    store.setMuted(true);
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { type: "reload" } as unknown as PerformanceEntry,
    ]);
    const bodies: Array<{ handle: MediaHandle; nextDeviceToken: string }> = [];
    vi.stubGlobal(
      "fetch",
      async (httpInput: RequestInfo | URL, init: RequestInit) => {
        const httpRequest = fetchRequest(httpInput, init);
        const path = new URL(httpRequest.url).pathname;

        if (path.endsWith("/config"))
          return Response.json({
            kind: "media_configuration",
            configured: true,
            maxParticipants: 16,
          });
        if (path.endsWith("/resume")) {
          const body = (await httpRequest.json()) as {
            handle: MediaHandle;
            nextDeviceToken: string;
          };
          bodies.push(body);
          expect(store.read()?.pending?.body).toEqual(body);
          if (bodies.length === 1) throw new TypeError("Response lost");
          return Response.json({
            kind: "joined",
            handle: {
              ...handle,
              accountGeneration: 2,
              deviceToken: body.nextDeviceToken,
            },
            generation: 2,
            producerVersion: 0,
            consumerVersion: 0,
            snapshot: {
              ...snapshot(),
              participants: [
                { ...participant("self"), generation: 2 },
                {
                  ...participant("peer", [
                    publication(
                      "66666666-6666-4666-8666-666666666666",
                      "microphone",
                    ),
                  ]),
                  userId: hiddenUserId,
                },
              ],
            },
          });
        }
        if (path.endsWith("/leave"))
          return Response.json({
            kind: "left",
            generation: 2,
            cleanupPending: false,
          });
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    const { MediaController } =
      await import("@/client/features/media/controller");
    const controller = new MediaController("self", "https://vaskel.test");
    const release = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().phase).toBe("active"),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]?.handle.deviceToken).toBe(handle.deviceToken);
    expect(bodies[0]?.nextDeviceToken).not.toBe(handle.deviceToken);
    expect(store.read()?.handle?.deviceToken).toBe(bodies[0]?.nextDeviceToken);
    expect(controller.getSnapshot().hiddenUserIds).toEqual([hiddenUserId]);
    expect(store.read()?.hiddenUserIds).toEqual([hiddenUserId]);
    expect(controller.getSnapshot().session!.remote).toEqual([]);
    await controller.leave();
    expect(controller.getSnapshot().hiddenUserIds).toEqual([]);
    release();
    await Promise.resolve();
  });

  it("offers transfer without sending a transfer command or allocating endpoints", async () => {
    browser();
    const fetch = vi.fn(async () =>
      Response.json({
        ...idle,
        generation: 3,
        admission: { kind: "transfer_required", room },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { MediaController } =
      await import("@/client/features/media/controller");
    const controller = new MediaController("self", "https://vaskel.test");
    await controller.join(room, "Lounge");
    expect(controller.getSnapshot().transfer?.generation).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ method: "GET" }),
    );
    controller.cancelTransfer();
    expect(controller.getSnapshot().transfer).toBeNull();
    controller.dispose();
  });

  it("reports pending cleanup without offering Move or sending a claim", async () => {
    const { controller, store, peers, calls } = await connected((path) => {
      if (path === "status")
        return wireResponse({
          ...idle,
          generation: 3,
          admission: { kind: "cleanup_pending" },
        });
    });
    try {
      expect(controller.getSnapshot()).toMatchObject({
        phase: "error",
        transfer: null,
        session: null,
        error: message("media.cleanupPending"),
      });
      expect(calls.map((call) => call.path)).toEqual(["status"]);
      expect(store.read()).toBeNull();
      expect(peers).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it.each(["missing", "closing", "wrong_generation"] as const)(
    "preserves owned intent when a %s roster entry precedes a provider failure",
    async (roster) => {
      vi.useFakeTimers();
      const pending = deferred<Response>();
      const next = snapshot();
      next.revision = 2;
      if (roster === "missing") next.participants.shift();
      else if (roster === "closing") next.participants[0]!.status = "closing";
      else next.participants[0]!.generation = 2;
      const { controller, store, peers, calls } = await connected((path) => {
        if (path === "publish") return pending.promise;
        if (path === "heartbeat")
          return wireResponse({
            kind: "heartbeat",
            expiresAt: Date.now() + 30_000,
            snapshot: next,
          });
      });
      const track = new FakeTrack("video");
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: async () =>
            new FakeStream([track as unknown as MediaStreamTrack]),
        },
      });
      const publishing = controller.startDevice("camera");
      await flush();
      expect(calls.at(-1)?.path).toBe("publish");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getSnapshot()).toMatchObject({
        phase: "error",
        room,
        session: null,
        pendingSources: [],
      });
      expect(controller.getSnapshot().error).toEqual(
        message("media.connectionEnded"),
      );
      expect(store.read()?.handle).toEqual(handle);
      expect(peers.every((peer) => peer.closed)).toBe(true);
      expect(track.stopped).toBeGreaterThan(0);
      const stopped = controller.getSnapshot();
      pending.resolve(
        wireResponse({
          kind: "provider_error",
          code: "late_provider_failure",
          retryable: true,
          uncertain: true,
        }),
      );
      await publishing;
      expect(controller.getSnapshot()).toEqual(stopped);
      expect(store.read()?.handle).toEqual(handle);
      expect(calls.some((call) => call.path === "resume")).toBe(false);
      await controller.leave();
      controller.dispose();
    },
  );

  it("recovers an accepted join using only the returned owned handle and explicit Resume", async () => {
    vi.useFakeTimers();
    let accepted: MediaHandle | undefined;
    const { controller, store, peers, calls } = await connected(
      (path, body) => {
        if (path === "join") {
          const command = JoinMediaRequestSchema.parse(body);
          accepted = {
            ...handle,
            clientId: command.clientId,
            deviceToken: command.deviceToken,
          };
          return wireResponse(
            {
              kind: "recovery_required",
              handle: accepted,
              reason: "admission_failed",
            },
            409,
          );
        }
        if (path === "resume") {
          const command = ResumeMediaRequestSchema.parse(body);
          expect(command.handle).toEqual(accepted);
          expect(command.nextDeviceToken).not.toBe(accepted?.deviceToken);
          return wireResponse({
            kind: "joined",
            handle: {
              ...command.handle,
              accountGeneration: 2,
              deviceToken: command.nextDeviceToken,
            },
            generation: 2,
            producerVersion: 0,
            consumerVersion: 0,
            snapshot: {
              ...snapshot(),
              participants: [{ ...participant("self"), generation: 2 }],
            },
          });
        }
      },
    );
    expect(controller.getSnapshot().phase).toBe("error");
    expect(store.read()?.handle).toEqual(accepted);
    expect(store.read()?.pending).toBeNull();
    expect(peers).toHaveLength(0);
    expect(calls.map((call) => call.path)).toEqual(["status", "join"]);
    await controller.resume();
    expect(controller.getSnapshot().phase).toBe("active");
    expect(calls.map((call) => call.path)).toEqual([
      "status",
      "join",
      "resume",
    ]);
    expect(store.read()?.handle?.accountGeneration).toBe(2);
    await controller.leave();
    controller.dispose();
  });

  it.each(["joined", "participation_ended"] as const)(
    "ignores late Resume %s after Leave and a new Join",
    async (kind) => {
      const pending = deferred<Response>();
      let resumes: unknown;
      let joins = 0;
      const replacement = {
        ...handle,
        accountGeneration: 3,
        deviceToken: "c".repeat(64),
      };
      const { controller, store, peers, calls } = await connected(
        (path, body) => {
          if (path === "resume") {
            resumes = body;
            return pending.promise;
          }
          if (path === "join" && ++joins > 1)
            return wireResponse({
              kind: "joined",
              handle: replacement,
              generation: 3,
              producerVersion: 0,
              consumerVersion: 0,
              snapshot: {
                ...snapshot(),
                participants: [{ ...participant("self"), generation: 3 }],
              },
            });
        },
      );
      const resuming = controller.resume();
      await flush();
      const leaving = controller.leave();
      expect(store.read()).toBeNull();
      await leaving;
      expect(
        LeaveMediaRequestSchema.parse(
          calls.find((call) => call.path === "leave")?.body,
        ),
      ).toMatchObject({ pending: { path: "resume", body: resumes } });
      await controller.join(room, "Replacement");
      const current = controller.getSnapshot();
      expect(current.phase).toBe("active");
      const command = ResumeMediaRequestSchema.parse(resumes);
      pending.resolve(
        wireResponse(
          kind === "participation_ended"
            ? { kind, generation: 1, reason: "removed" }
            : {
                kind,
                handle: {
                  ...handle,
                  accountGeneration: 2,
                  deviceToken: command.nextDeviceToken,
                },
                generation: 2,
                producerVersion: 0,
                consumerVersion: 0,
                snapshot: {
                  ...snapshot(),
                  participants: [{ ...participant("self"), generation: 2 }],
                },
              },
        ),
      );
      await resuming;
      expect(controller.getSnapshot()).toEqual(current);
      expect(store.read()?.handle).toEqual(replacement);
      expect(peers).toHaveLength(4);
      expect(peers.slice(2).every((peer) => !peer.closed)).toBe(true);
      await controller.leave();
      controller.dispose();
    },
  );
});
