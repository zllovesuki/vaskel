import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplacedGeneration } from "@/client/features/media/protocol";
import { gatheredLocalDescription } from "@/client/features/media/readiness";
import { type MediaTransport } from "@/client/features/media/session";
import {
  publication,
  snapshot,
  flush,
  FakeTrack,
  FakeStream,
  FakePeer,
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

describe("media readiness", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  function negotiationTransport(
    calls: Array<{ path: string; body: unknown }>,
  ): MediaTransport {
    return async (path, body) => {
      calls.push({ path, body });
      const command = body as { operationId: string };
      if (path === "publish" || path === "subscribe")
        return {
          kind: "negotiation",
          operationId: command.operationId,
          sessionVersion: 1,
          phase: path === "publish" ? "awaiting_apply" : "awaiting_answer",
          sessionDescription: {
            type: path === "publish" ? "answer" : "offer",
            sdp: "remote",
          },
          publications: [],
          subscriptions: [],
          deadline: Date.now() + 10_000,
        };
      return {
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: 1,
        revision: 1,
      };
    };
  }
  function assertWaitListenersRemoved(peer: FakePeer, signal: AbortSignal) {
    const added = vi.spyOn(peer, "addEventListener");
    const removed = vi.spyOn(peer, "removeEventListener");
    const abortAdded = vi.spyOn(signal, "addEventListener");
    const abortRemoved = vi.spyOn(signal, "removeEventListener");
    return () => {
      expect(added.mock.calls.length).toBeGreaterThan(0);
      for (const [event, listener] of added.mock.calls)
        expect(removed).toHaveBeenCalledWith(event, listener);
      for (const [event, listener] of abortAdded.mock.calls)
        expect(abortRemoved).toHaveBeenCalledWith(event, listener);
    };
  }
  it("distinguishes each peer's initial setup from an established connection recovering", () => {
    vi.useFakeTimers();
    const { session, peers, connection, failed } = sessionHarness(
      negotiationTransport([]),
    );
    const observed: boolean[] = [];
    connection.mockImplementation(() => observed.push(session.reconnecting));
    expect(session.reconnecting).toBe(false);
    const [producer, consumer] = peers;
    producer!.connect("connecting");
    producer!.connect("connected");
    // A connected producer does not turn the consumer's first setup into recovery.
    consumer!.connect("connecting");
    consumer!.connect("connected");
    producer!.connect("disconnected");
    producer!.connect("connecting");
    producer!.connect("connected");
    consumer!.connect("disconnected");
    consumer!.connect("connecting");
    consumer!.connect("connected");
    expect(observed).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  });
  it("sends gathered producer SDP with sendonly tracks and gathers again for later offers", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const { session, peers } = sessionHarness(negotiationTransport(calls));
    const peer = peers[0]!;
    peer.autoGather = false;
    for (const source of ["microphone", "camera"] as const) {
      const track = new FakeTrack();
      const publishing = session.publish([
        { source, track: track as unknown as MediaStreamTrack },
      ]);
      await flush();
      expect(peer.iceGatheringState).toBe("gathering");
      expect(calls.filter((call) => call.path === "publish")).toHaveLength(
        source === "microphone" ? 0 : 1,
      );
      peer.completeGather(`gathered-${source}`);
      await publishing;
      expect(calls.at(-2)?.body).toMatchObject({
        sessionDescription: { type: "offer", sdp: `gathered-${source}` },
      });
      expect(peer.transceivers.at(-1)?.direction).toBe("sendonly");
    }
    session.dispose();
  });
  it("waits from initial new through gathering beyond five seconds before publishing", async () => {
    vi.useFakeTimers();
    const calls: Array<{ path: string; body: unknown }> = [];
    const { session, peers } = sessionHarness(negotiationTransport(calls));
    const peer = peers[0]!;
    vi.spyOn(peer, "setLocalDescription").mockImplementation(
      async (description) => {
        peer.localDescription = description;
        peer.iceGatheringState = "new";
      },
    );
    const assertRemoved = assertWaitListenersRemoved(
      peer,
      session.abort.signal,
    );
    const publishing = session.publish([
      {
        source: "microphone",
        track: new FakeTrack() as unknown as MediaStreamTrack,
      },
    ]);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([]);
    peer.iceGatheringState = "gathering";
    peer.dispatchEvent(new Event("icegatheringstatechange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual([]);
    peer.completeGather("complete-offer-after-six-seconds");
    await publishing;
    expect(calls.map((call) => call.path)).toEqual(["publish", "ack"]);
    expect(calls[0]?.body).toMatchObject({
      sessionDescription: {
        type: "offer",
        sdp: "complete-offer-after-six-seconds",
      },
    });
    assertRemoved();
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();
    session.dispose();
  });
  it("sends gathered consumer SDP and removes readiness listeners on success", async () => {
    vi.useFakeTimers();
    const calls: Array<{ path: string; body: unknown }> = [];
    const { session, peers } = sessionHarness(
      negotiationTransport(calls),
      snapshot([publication("mic", "microphone")]),
    );
    const peer = peers[1]!;
    peer.autoGather = false;
    const assertRemoved = assertWaitListenersRemoved(
      peer,
      session.abort.signal,
    );
    session.reconcile();
    await flush();
    expect(calls.map((call) => call.path)).toEqual(["subscribe"]);
    peer.completeGather("gathered-answer");
    await flush();
    expect(calls[1]?.body).toMatchObject({
      sessionDescription: { type: "answer", sdp: "gathered-answer" },
    });
    assertRemoved();
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  });
  it.each(["abort", "owner deadline"])(
    "does not send a consumer answer after gathering ends with %s",
    async (reason) => {
      vi.useFakeTimers();
      const calls: Array<{ path: string; body: unknown }> = [];
      const transport = negotiationTransport(calls);
      const { session, peers, failed } = sessionHarness(
        async (...args) => {
          const result = await transport(...args);
          return result.kind === "negotiation"
            ? { ...result, deadline: Date.now() + 2_000 }
            : result;
        },
        snapshot([publication("mic", "microphone")]),
      );
      const peer = peers[1]!;
      peer.autoGather = false;
      const assertRemoved = assertWaitListenersRemoved(
        peer,
        session.abort.signal,
      );
      session.reconcile();
      await flush();
      peer.localDescription = {
        type: "answer",
        sdp: "a=candidate:1 1 udp 1 private.local 10000 typ host",
      };
      if (reason === "abort") session.dispose();
      else {
        await vi.advanceTimersByTimeAsync(999);
        expect(failed).not.toHaveBeenCalled();
        expect(calls.map((call) => call.path)).toEqual(["subscribe"]);
        await vi.advanceTimersByTimeAsync(1);
      }
      await flush();
      expect(failed).toHaveBeenCalledOnce();
      if (reason === "abort")
        expect(failed).toHaveBeenCalledWith(expect.any(ReplacedGeneration));
      assertRemoved();
      expect(vi.getTimerCount()).toBe(0);
      peer.completeGather("late-answer");
      await session.consumerQueue.run(async () => {});
      expect(calls.map((call) => call.path)).toEqual(["subscribe"]);
      session.dispose();
    },
  );
  it.each(["gathering", "connecting"])(
    "aborts %s on leave, stops capture and releases the queue",
    async (stage) => {
      vi.useFakeTimers();
      const calls: Array<{ path: string; body: unknown }> = [];
      const { session, peers } = sessionHarness(negotiationTransport(calls));
      const peer = peers[0]!;
      peer.autoGather = stage !== "gathering";
      peer.autoConnect = false;
      const assertRemoved = assertWaitListenersRemoved(
        peer,
        session.abort.signal,
      );
      const track = new FakeTrack();
      const publishing = session.publish([
        { source: "microphone", track: track as unknown as MediaStreamTrack },
      ]);
      const rejected =
        expect(publishing).rejects.toBeInstanceOf(ReplacedGeneration);
      await flush();
      session.dispose();
      await rejected;
      await session.producerQueue.run(async () => {});
      assertRemoved();
      expect(vi.getTimerCount()).toBe(0);
      expect(track.stopped).toBeGreaterThan(0);
      peer.completeGather("late");
      peer.connect();
      expect(calls.map((call) => call.path)).toEqual(
        stage === "gathering" ? [] : ["publish"],
      );
    },
  );
  it.each(["host-only", "host and srflx"])(
    "signals the latest %s SDP on the first candidate event but still waits for connection before ACK",
    async (candidates) => {
      vi.useFakeTimers();
      vi.stubEnv("DEV", true);
      const calls: Array<{ path: string; body: unknown }> = [];
      const { session, peers } = sessionHarness(negotiationTransport(calls));
      const peer = peers[0]!;
      peer.autoGather = false;
      peer.autoConnect = false;
      const assertRemoved = assertWaitListenersRemoved(
        peer,
        session.abort.signal,
      );
      const publishing = session.publish([
        {
          source: "microphone",
          track: new FakeTrack() as unknown as MediaStreamTrack,
        },
      ]);
      await flush();
      peer.dispatchEvent(new Event("icecandidate"));
      await flush();
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(25);
      const latest = [
        "a=ice-pwd:must-not-be-logged",
        "a=candidate:1 1 udp 1 private.local 10000 typ host",
        ...(candidates === "host and srflx"
          ? [
              "a=candidate:2 1 udp 1 192.0.2.1 10000 typ srflx raddr 192.0.2.2 rport 10000",
            ]
          : []),
      ].join("\r\n");
      peer.localDescription = { type: "offer", sdp: latest };
      peer.dispatchEvent(new Event("icecandidate"));
      await flush();
      expect(calls.map((call) => call.path)).toEqual(["publish"]);
      expect(calls[0]?.body).toMatchObject({
        sessionDescription: { type: "offer", sdp: latest },
      });
      expect(peer.iceGatheringState).toBe("gathering");
      peer.connect();
      await publishing;
      expect(calls.map((call) => call.path)).toEqual(["publish", "ack"]);
      assertRemoved();
      expect(vi.getTimerCount()).toBe(0);
      expect(console.warn).not.toHaveBeenCalled();
      session.dispose();
    },
  );
  it.each(["aborted", "closed", "failed", "new"])(
    "checks %s at the timeout callback before accepting candidate-bearing SDP",
    async (reason) => {
      vi.useFakeTimers();
      const peer = new FakePeer();
      peer.iceGatheringState = "gathering";
      peer.localDescription = { type: "offer", sdp: "offer" };
      const abort = new AbortController();
      const assertRemoved = assertWaitListenersRemoved(peer, abort.signal);
      const pending = gatheredLocalDescription(
        peer as unknown as RTCPeerConnection,
        abort.signal,
      );
      const rejected =
        reason === "aborted"
          ? expect(pending).rejects.toBeInstanceOf(ReplacedGeneration)
          : expect(pending).rejects.toThrow(
              reason === "new"
                ? "media.captureTimeout"
                : "media.connectionEnded",
            );
      // Candidate and terminal state change without events, exercising the timer's guard.
      peer.localDescription = {
        type: "offer",
        sdp: "a=candidate:1 1 udp 1 private.local 10000 typ host",
      };
      if (reason === "aborted")
        vi.spyOn(abort.signal, "aborted", "get").mockReturnValue(true);
      else if (reason === "new") peer.iceGatheringState = "new";
      else peer.connectionState = reason;
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      assertRemoved();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["gathering", "connecting"])(
    "bounds %s, cleans its wait and releases the queue",
    async (stage) => {
      vi.useFakeTimers();
      vi.stubEnv("DEV", stage === "gathering");
      const calls: Array<{ path: string; body: unknown }> = [];
      const { session, peers } = sessionHarness(negotiationTransport(calls));
      const peer = peers[0]!;
      peer.autoGather = stage !== "gathering";
      peer.autoConnect = false;
      const assertRemoved = assertWaitListenersRemoved(
        peer,
        session.abort.signal,
      );
      const track = new FakeTrack();
      const publishing = session.publish([
        { source: "microphone", track: track as unknown as MediaStreamTrack },
      ]);
      const rejected = expect(publishing).rejects.toThrow(
        stage === "gathering"
          ? "media.captureTimeout"
          : "media.connectionTimeout",
      );
      await flush();
      peer.localDescription = {
        type: "offer",
        sdp: ["a=ice-pwd:must-not-be-logged", "o=- 1 1 IN IP4 192.0.2.1"].join(
          "\r\n",
        ),
      };
      await vi.advanceTimersByTimeAsync(stage === "gathering" ? 10_000 : 5_000);
      await rejected;
      expect(vi.mocked(console.warn).mock.calls).toEqual(
        stage === "gathering"
          ? [
              [
                "Media readiness timed out.",
                {
                  stage: "gathering",
                  elapsedMs: 10_000,
                  iceGatheringState: "gathering",
                  iceConnectionState: "new",
                  connectionState: "new",
                  candidateCounts: {
                    host: 0,
                    srflx: 0,
                    prflx: 0,
                    relay: 0,
                    other: 0,
                  },
                },
              ],
            ]
          : [],
      );
      await session.producerQueue.run(async () => {});
      assertRemoved();
      expect(vi.getTimerCount()).toBe(0);
      expect(track.stopped).toBeGreaterThan(0);
      expect(calls.map((call) => call.path)).toEqual(
        stage === "gathering" ? [] : ["publish"],
      );
      session.dispose();
    },
  );
  it.each(["failed", "closed"])(
    "rejects a producer becoming %s before ACK",
    async (state) => {
      vi.useFakeTimers();
      const calls: Array<{ path: string; body: unknown }> = [];
      const { session, peers } = sessionHarness(negotiationTransport(calls));
      const peer = peers[0]!;
      peer.autoConnect = false;
      const assertRemoved = assertWaitListenersRemoved(
        peer,
        session.abort.signal,
      );
      const publishing = session.publish([
        {
          source: "microphone",
          track: new FakeTrack() as unknown as MediaStreamTrack,
        },
      ]);
      const rejected = expect(publishing).rejects.toThrow(
        "media.connectionEnded",
      );
      await flush();
      peer.connect(state);
      await rejected;
      assertRemoved();
      expect(vi.getTimerCount()).toBe(0);
      expect(calls.map((call) => call.path)).toEqual(["publish"]);
      session.dispose();
    },
  );
  it("leaves time for ACK before the server deadline when the response arrives late", async () => {
    vi.useFakeTimers();
    const calls: Array<{ path: string; body: unknown }> = [];
    const transport = negotiationTransport(calls);
    const { session, peers } = sessionHarness(async (...args) => {
      const result = await transport(...args);
      return result.kind === "negotiation"
        ? { ...result, deadline: Date.now() + 2_000 }
        : result;
    });
    peers[0]!.autoConnect = false;
    const publishing = session.publish([
      {
        source: "microphone",
        track: new FakeTrack() as unknown as MediaStreamTrack,
      },
    ]);
    const rejected = expect(publishing).rejects.toThrow(
      "media.connectionTimeout",
    );
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.map((call) => call.path)).toEqual(["publish"]);
    session.dispose();
  });
});
