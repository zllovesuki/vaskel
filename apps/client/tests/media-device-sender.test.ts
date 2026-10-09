import { deferred } from "@tests/shared/deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplacedGeneration } from "@/client/features/media/protocol";
import {
  snapshot,
  flush,
  FakeTrack,
  FakeStream,
  sessionHarness,
} from "@tests/helpers/media";

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("device sender replacement", () => {
  async function published(source: "microphone" | "camera" = "microphone") {
    const calls: string[] = [];
    const harness = sessionHarness(async (path, body) => {
      calls.push(path);
      const { operationId } = body as { operationId: string };
      return path === "publish"
        ? {
            kind: "negotiation",
            operationId,
            sessionVersion: 1,
            phase: "awaiting_apply",
            sessionDescription: { type: "answer", sdp: "answer" },
            publications: [],
            subscriptions: [],
            deadline: Date.now() + 10_000,
          }
        : { kind: "completed", operationId, sessionVersion: 1, revision: 1 };
    });
    const old = new FakeTrack(source === "camera" ? "video" : "audio");
    await harness.session.publish([
      { source, track: old as unknown as MediaStreamTrack },
    ]);
    return {
      ...harness,
      old,
      calls,
      sender: harness.peers[0]!.transceivers[0]!.sender,
    };
  }
  it.each(["microphone", "camera"] as const)(
    "preserves the %s sender and publication, retires the old stream and stops capture",
    async (source) => {
      const { session, old, calls, sender, peers, sourceEnded } =
        await published(source);
      const remove = vi.spyOn(old, "removeEventListener");
      const stream = session.localMedia()[0]!.stream;
      const next = new FakeTrack(old.kind);
      await session.replaceDevice(
        { source, track: next as unknown as MediaStreamTrack },
        () => true,
      );
      expect(sender.track).toBe(next);
      expect(peers[0]!.transceivers).toHaveLength(1);
      expect(calls).toEqual(["publish", "ack"]);
      expect(old.readyState).toBe("ended");
      expect(stream.getTracks()).toEqual([]);
      expect(next.enabled).toBe(source === "camera");
      expect(session.localMedia()[0]!.stream.getTracks()).toEqual([next]);
      expect(remove).toHaveBeenCalledWith("ended", expect.any(Function));
      old.dispatchEvent(new Event("ended"));
      expect(sourceEnded).not.toHaveBeenCalled();
      next.dispatchEvent(new Event("ended"));
      expect(sourceEnded).toHaveBeenCalledExactlyOnceWith(source);
      session.dispose();
      expect(next.readyState).toBe("ended");
    },
  );
  it.each(["microphone", "camera"] as const)(
    "republishes %s only when the negotiated envelope rejects replacement",
    async (source) => {
      const { session, old, sender, peers, calls } = await published(source);
      sender.replaceTrack.mockRejectedValueOnce(
        new DOMException("envelope", "InvalidModificationError"),
      );
      const next = new FakeTrack(old.kind);
      await session.replaceDevice(
        { source, track: next as unknown as MediaStreamTrack },
        () => true,
      );
      expect(calls).toEqual(["publish", "ack", "unpublish", "publish", "ack"]);
      expect(old.readyState).toBe("ended");
      expect(next.readyState).toBe("live");
      expect(next.enabled).toBe(source === "camera");
      const failed = new FakeTrack(old.kind);
      peers[0]!.transceivers[1]!.sender.replaceTrack.mockRejectedValueOnce(
        new DOMException("closed", "InvalidStateError"),
      );
      await expect(
        session.replaceDevice(
          { source, track: failed as unknown as MediaStreamTrack },
          () => true,
        ),
      ).rejects.toThrow("closed");
      expect(failed.readyState).toBe("ended");
      session.dispose();
    },
  );
  it.each(["leave", "stop", "moderation", "superseded"])(
    "stops delayed replacement after %s without reviving capture",
    async (action) => {
      const { session, old, sender, calls } = await published();
      const gate = deferred<void>();
      sender.replaceTrack.mockImplementationOnce(
        async (next: MediaStreamTrack) => {
          await gate.promise;
          sender.track = next;
        },
      );
      const next = new FakeTrack();
      let current = true;
      const replacement = session.replaceDevice(
        { source: "microphone", track: next as unknown as MediaStreamTrack },
        () => current,
      );
      const rejected =
        expect(replacement).rejects.toBeInstanceOf(ReplacedGeneration);
      await flush();
      expect(next.enabled).toBe(false);
      let stopping: Promise<void> | undefined;
      if (action === "leave") session.dispose();
      else if (action === "stop")
        stopping = session.stopSources(["microphone"]);
      else if (action === "moderation") {
        const state = snapshot();
        state.revision++;
        state.participants[0]!.muted = true;
        session.updateSnapshot(state);
      } else current = false;
      if (action !== "superseded") expect(next.readyState).toBe("ended");
      gate.resolve();
      await rejected;
      await stopping;
      await flush();
      expect(next.readyState).toBe("ended");
      expect(calls.filter((path) => path === "publish")).toHaveLength(1);
      if (action !== "superseded") expect(old.readyState).toBe("ended");
      session.dispose();
    },
  );
});
