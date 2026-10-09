import { fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { message } from "@/client/features/i18n/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaOutcomeSchema,
  PublishMediaRequestSchema,
} from "@vaskel/contracts/media";
import { IntentStore } from "@/client/features/media/intent";
import {
  room,
  handle,
  snapshot,
  flush,
  wireResponse,
  FakeTrack,
  FakeStream,
  audioContexts,
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
  it("keeps default join on direct microphone capture without creating silent audio", async () => {
    const contexts = audioContexts();
    const track = new FakeTrack();
    const capture = vi.fn(
      async () => new FakeStream([track as unknown as MediaStreamTrack]),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    const { controller, calls } = await connected(undefined, false);
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "ack")).toHaveLength(1),
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(0);
    expect(controller.getSnapshot().muted).toBe(false);
    expect(controller.getSnapshot().session!.local).toHaveLength(1);
    controller.dispose();
  });

  it("publishes muted silence without microphone capture, preserves it on denial, then replaces its sender", async () => {
    const contexts = audioContexts();
    const track = new FakeTrack();
    const capture = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce(
        new FakeStream([track as unknown as MediaStreamTrack]),
      );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    const { controller, calls, peers } = await connected();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "ack")).toHaveLength(1),
    );
    expect(capture).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session!.local).toEqual([]);
    const sender = peers[0]!.transceivers[0]!.sender;
    expect(sender.track).toBe(contexts[0]!.track);
    expect(sender.track.enabled).toBe(true);
    controller.toggleMute();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().error).toEqual(
        message("media.microphoneDenied"),
      ),
    );
    expect(controller.getSnapshot().muted).toBe(true);
    expect(sender.track).toBe(contexts[0]!.track);
    expect(contexts[0]!.close).not.toHaveBeenCalled();
    controller.toggleMute();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().session!.local).toHaveLength(1),
    );
    expect(sender.track).toBe(track);
    expect(peers[0]!.transceivers).toHaveLength(1);
    expect(calls.filter((call) => call.path === "publish")).toHaveLength(1);
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    controller.toggleMute();
    expect(track.enabled).toBe(false);
    expect(contexts).toHaveLength(1);
    controller.dispose();
  });

  it("retains capture-error feedback while starting silence after initial denial", async () => {
    const contexts = audioContexts();
    const capture = vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    const { controller, calls } = await connected(undefined, false);
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "ack")).toHaveLength(1),
    );
    expect(contexts).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      muted: true,
      error: message("media.microphoneDenied"),
    });
    controller.dispose();
  });

  it.each([false, true])(
    "handles silent-source replacement failure with fallback only when required (%s)",
    async (fallback) => {
      const contexts = audioContexts();
      const track = new FakeTrack();
      const capture = vi.fn(
        async () => new FakeStream([track as unknown as MediaStreamTrack]),
      );
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
      const { controller, calls, peers } = await connected();
      await vi.waitFor(() =>
        expect(calls.filter((call) => call.path === "ack")).toHaveLength(1),
      );
      const sender = peers[0]!.transceivers[0]!.sender;
      sender.replaceTrack.mockRejectedValueOnce(
        new DOMException(
          "replacement failed",
          fallback ? "InvalidModificationError" : "InvalidStateError",
        ),
      );
      controller.toggleMute();
      await vi.waitFor(() =>
        expect(controller.getSnapshot().pendingSources).toEqual([]),
      );
      expect(controller.getSnapshot().phase).toBe("active");
      if (fallback) {
        expect(calls.filter((call) => call.path === "unpublish")).toHaveLength(
          1,
        );
        expect(calls.filter((call) => call.path === "publish")).toHaveLength(2);
        expect(controller.getSnapshot().session!.local).toHaveLength(1);
        expect(contexts[0]!.close).toHaveBeenCalledOnce();
      } else {
        expect(calls.filter((call) => call.path === "publish")).toHaveLength(1);
        expect(controller.getSnapshot().muted).toBe(true);
        expect(sender.track).toBe(contexts[0]!.track);
        expect(contexts[0]!.close).not.toHaveBeenCalled();
        expect(track.readyState).toBe("ended");
      }
      controller.dispose();
    },
  );

  it("waits for Enable call audio before publishing suspended silence", async () => {
    vi.useFakeTimers();
    const contexts = audioContexts(true);
    const { controller, calls } = await connected();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getSnapshot().playbackBlocked).toBe(true);
    expect(calls.some((call) => call.path === "publish")).toBe(false);
    contexts[0]!.resume.mockImplementation(async () => {
      contexts[0]!.state = "running";
    });
    controller.enableAudio();
    await flush();
    expect(controller.getSnapshot().playbackBlocked).toBe(false);
    expect(calls.filter((call) => call.path === "publish")).toHaveLength(1);
    controller.dispose();
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
  });

  it("disposes blocked silence on leave without publishing when a late resume settles", async () => {
    vi.useFakeTimers();
    const contexts = audioContexts(true);
    const { controller, calls } = await connected();
    await controller.leave();
    contexts[0]!.state = "running";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.some((call) => call.path === "publish")).toBe(false);
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("keeps receive membership when silent publishing is restricted and releases its source", async () => {
    const contexts = audioContexts();
    let restricted = true;
    const { controller, calls, peers } = await connected((path) => {
      if (path === "publish" && restricted)
        return wireResponse(
          { kind: "action_restricted", restriction: "mute" },
          403,
        );
    });
    await vi.waitFor(() =>
      expect(controller.getSnapshot().pendingSources).toEqual([]),
    );
    await flush();
    expect(controller.getSnapshot().phase).toBe("active");
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(peers.every((peer) => !peer.closed)).toBe(true);
    expect(calls.some((call) => call.path === "ack")).toBe(false);
    restricted = false;
    controller.enableAudio();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "ack")).toHaveLength(1),
    );
    expect(contexts).toHaveLength(2);
    controller.dispose();
  });

  it("does not publish silence while server muted and disposes prepared audio", async () => {
    const contexts = audioContexts();
    const state = snapshot();
    state.participants[0]!.muted = true;
    const { controller, calls } = await connected((path) => {
      if (path === "join")
        return wireResponse({
          kind: "joined",
          handle,
          generation: 1,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: state,
        });
    });
    await flush();
    expect(controller.getSnapshot().phase).toBe("active");
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.path === "publish")).toBe(false);
    controller.dispose();
  });

  it.each([false, true])(
    "switches devices with publication fallback only when needed (%s)",
    async (fallback) => {
      const { controller, calls, peers } = await connected();
      const old = new FakeTrack();
      const next = new FakeTrack();
      const capture = vi
        .fn()
        .mockResolvedValueOnce(
          new FakeStream([old as unknown as MediaStreamTrack]),
        )
        .mockResolvedValueOnce(
          new FakeStream([next as unknown as MediaStreamTrack]),
        );
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
      controller.toggleMute();
      await vi.waitFor(() =>
        expect(controller.getSnapshot().session!.local).toHaveLength(1),
      );
      if (fallback)
        peers[0]!.transceivers[0]!.sender.replaceTrack.mockRejectedValueOnce(
          new DOMException("envelope", "InvalidModificationError"),
        );
      await controller.switchDevice("microphone", "next-device");
      expect(capture.mock.calls[1]![0].audio.deviceId).toEqual({
        exact: "next-device",
      });
      expect(
        calls
          .map(({ path }) => path)
          .filter((path) => ["publish", "ack", "unpublish"].includes(path)),
      ).toEqual(
        fallback
          ? ["publish", "ack", "unpublish", "publish", "ack"]
          : ["publish", "ack"],
      );
      expect(old.readyState).toBe("ended");
      expect(next.readyState).toBe("live");
      expect(
        controller.getSnapshot().session!.local[0]!.stream.getTracks(),
      ).toEqual([next]);
      controller.dispose();
    },
  );

  it("stops replacement capture immediately when leaving during fallback unpublish", async () => {
    const closed = deferred<void>();
    const { controller, peers, calls } = await connected((path, body) => {
      if (path !== "unpublish") return undefined;
      return closed.promise.then(() =>
        wireResponse({
          kind: "completed",
          operationId: (body as { operationId: string }).operationId,
          sessionVersion: 1,
          revision: 1,
        }),
      );
    });
    const old = new FakeTrack();
    const next = new FakeTrack();
    const capture = vi
      .fn()
      .mockResolvedValueOnce(
        new FakeStream([old as unknown as MediaStreamTrack]),
      )
      .mockResolvedValueOnce(
        new FakeStream([next as unknown as MediaStreamTrack]),
      );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    controller.toggleMute();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().session!.local).toHaveLength(1),
    );
    peers[0]!.transceivers[0]!.sender.replaceTrack.mockRejectedValueOnce(
      new DOMException("envelope", "InvalidModificationError"),
    );
    const switching = controller.switchDevice("microphone", "next");
    await vi.waitFor(() => expect(calls.at(-1)?.path).toBe("unpublish"));
    await controller.leave();
    expect(next.readyState).toBe("ended");
    closed.resolve();
    await switching;
    expect(calls.filter(({ path }) => path === "publish")).toHaveLength(1);
    controller.dispose();
  });

  it("publishes only the latest capture when a switch overtakes republish fallback", async () => {
    const closed = deferred<void>();
    const { controller, peers, calls } = await connected((path, body) => {
      if (path !== "unpublish") return undefined;
      return closed.promise.then(() =>
        wireResponse({
          kind: "completed",
          operationId: (body as { operationId: string }).operationId,
          sessionVersion: 1,
          revision: 1,
        }),
      );
    });
    const old = new FakeTrack();
    const obsolete = new FakeTrack();
    const latest = new FakeTrack();
    const capture = vi.fn();
    for (const track of [old, obsolete, latest])
      capture.mockResolvedValueOnce(
        new FakeStream([track as unknown as MediaStreamTrack]),
      );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    controller.toggleMute();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().session!.local).toHaveLength(1),
    );
    peers[0]!.transceivers[0]!.sender.replaceTrack.mockRejectedValueOnce(
      new DOMException("envelope", "InvalidModificationError"),
    );
    const first = controller.switchDevice("microphone", "obsolete");
    await vi.waitFor(() => expect(calls.at(-1)?.path).toBe("unpublish"));
    const second = controller.switchDevice("microphone", "latest");
    closed.resolve();
    await Promise.all([first, second]);
    expect(obsolete.readyState).toBe("ended");
    expect(latest.readyState).toBe("live");
    expect(
      controller.getSnapshot().session!.local[0]!.stream.getTracks(),
    ).toEqual([latest]);
    expect(calls.filter(({ path }) => path === "publish")).toHaveLength(2);
    controller.dispose();
  });

  it("retains the active source on capture denial and stops a superseded capture", async () => {
    const { controller } = await connected();
    const old = new FakeTrack();
    const late = new FakeTrack();
    const next = new FakeTrack();
    const gate = deferred<MediaStream>();
    const capture = vi
      .fn()
      .mockResolvedValueOnce(
        new FakeStream([old as unknown as MediaStreamTrack]),
      )
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(
        new FakeStream([next as unknown as MediaStreamTrack]),
      );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    controller.toggleMute();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().session!.local).toHaveLength(1),
    );
    await controller.switchDevice("microphone", "denied");
    expect(old.readyState).toBe("live");
    expect(controller.getSnapshot().muted).toBe(false);
    const stale = controller.switchDevice("microphone", "late");
    expect(controller.getSnapshot().pendingSources).toEqual(["microphone"]);
    expect(
      controller.getSnapshot().session!.local[0]!.stream.getTracks(),
    ).toEqual([old]);
    await controller.switchDevice("microphone", "next");
    gate.resolve(
      new FakeStream([
        late as unknown as MediaStreamTrack,
      ]) as unknown as MediaStream,
    );
    await stale;
    expect(late.readyState).toBe("ended");
    expect(
      controller.getSnapshot().session!.local[0]!.stream.getTracks(),
    ).toEqual([next]);
    controller.dispose();
  });

  it("stops capture arriving after leave and clears intent before server cleanup finishes", async () => {
    const { storage } = browser();
    const capture = deferred<MediaStream>();
    const cleanup = deferred<Response>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => capture.promise },
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (httpInput: RequestInfo | URL) => {
      const httpRequest = fetchRequest(httpInput);
      const path = new URL(httpRequest.url).pathname;

      calls.push(path);
      if (path.endsWith("/status")) return Response.json(idle);
      if (path.endsWith("/join"))
        return Response.json({
          kind: "joined",
          handle,
          generation: 1,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: snapshot(),
        });
      if (path.endsWith("/leave")) return cleanup.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const { MediaController } =
      await import("@/client/features/media/controller");
    const controller = new MediaController("self", "https://vaskel.test");
    await controller.join(room, "Lounge");
    expect(controller.getSnapshot().phase).toBe("active");
    const leaving = controller.leave();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      session: null,
      pendingSources: [],
      joinedAt: null,
    });
    expect(
      new IntentStore("https://vaskel.test", "self", storage).read(),
    ).toBeNull();
    const track = new FakeTrack();
    capture.resolve(
      new FakeStream([
        track as unknown as MediaStreamTrack,
      ]) as unknown as MediaStream,
    );
    await vi.waitFor(() => expect(track.stopped).toBe(1));
    expect(calls.some((path) => path.endsWith("/publish"))).toBe(false);
    cleanup.resolve(
      Response.json({ kind: "left", generation: 1, cleanupPending: false }),
    );
    await leaving;
    expect(controller.getSnapshot().phase).toBe("idle");
    controller.dispose();
  });

  it("rolls back a restricted publication without ending the call or blocking a later source", async () => {
    const { controller, store, peers, calls } = await connected(
      (path, body) => {
        if (
          path === "publish" &&
          PublishMediaRequestSchema.parse(body).tracks[0]?.source === "camera"
        )
          return wireResponse(
            MediaOutcomeSchema.parse({
              kind: "action_restricted",
              restriction: "camera",
            }),
            403,
          );
      },
    );
    const camera = new FakeTrack("video");
    const microphone = new FakeTrack();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async (constraints: MediaStreamConstraints) =>
          new FakeStream([
            (constraints.video
              ? camera
              : microphone) as unknown as MediaStreamTrack,
          ]),
      },
    });
    await controller.startDevice("camera");
    expect(camera.stopped).toBeGreaterThan(0);
    expect(peers[0]?.localDescription).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      session: { local: [] },
      pendingSources: [],
    });
    expect(controller.getSnapshot().error).toEqual(
      message("media.cameraRestricted"),
    );
    expect(store.read()?.handle).toEqual(handle);
    expect(peers.some((peer) => peer.closed)).toBe(false);
    await controller.startDevice("microphone");
    expect(
      controller.getSnapshot().session!.local.map((item) => item.source),
    ).toEqual(["microphone"]);
    expect(calls.filter((call) => call.path === "ack")).toHaveLength(1);
    await controller.leave();
    controller.dispose();
  });

  it("stops late capture from the old call without clearing replacement capture", async () => {
    const { controller } = await connected();
    const oldCapture = deferred<MediaStream>();
    const newCapture = deferred<MediaStream>();
    const oldTrack = new FakeTrack("video");
    const newTrack = new FakeTrack("video");
    const capture = vi
      .fn()
      .mockReturnValueOnce(oldCapture.promise)
      .mockReturnValueOnce(newCapture.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    const oldPending = controller.startDevice("camera");
    await controller.leave();
    await controller.join(room, "Replacement");
    const newPending = controller.startDevice("camera");
    oldCapture.resolve(
      new FakeStream([
        oldTrack as unknown as MediaStreamTrack,
      ]) as unknown as MediaStream,
    );
    await oldPending;
    expect(oldTrack.stopped).toBe(1);
    expect(controller.getSnapshot().pendingSources).toEqual(["camera"]);
    expect(controller.getSnapshot().phase).toBe("active");
    newCapture.resolve(
      new FakeStream([
        newTrack as unknown as MediaStreamTrack,
      ]) as unknown as MediaStream,
    );
    await newPending;
    expect(newTrack.stopped).toBe(0);
    expect(controller.getSnapshot().pendingSources).toEqual([]);
    expect(
      controller.getSnapshot().session!.local.map((item) => item.source),
    ).toEqual(["camera"]);
    await controller.leave();
    controller.dispose();
  });
});
