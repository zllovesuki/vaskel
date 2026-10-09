import { deferred } from "@tests/shared/deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MediaOutcome } from "@vaskel/contracts/media";
import {
  ReplacedGeneration,
  SessionQueue,
} from "@/client/features/media/protocol";
import { type MediaTransport } from "@/client/features/media/session";
import {
  publication,
  participant,
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

describe("explicit viewer reception choices", () => {
  it("keeps the selected screen and its audio in PiP while retiring cameras", async () => {
    const camera = publication("camera", "camera");
    const screen = publication("screen", "screen_video");
    const audio = publication("screen-audio", "screen_audio");
    const publications = [camera, screen, audio];
    const requests: string[][] = [];
    const rpc: MediaTransport = async (_path, body) => {
      const command = body as { operationId: string; publicationIds: string[] };
      requests.push(command.publicationIds);
      return {
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: requests.length,
        revision: 1,
        subscriptions: publications
          .filter((item) => command.publicationIds.includes(item.id))
          .map((item) => ({ publication: item, mid: item.id })),
      };
    };
    const { session, peers, failed } = sessionHarness(
      rpc,
      snapshot(publications),
    );
    for (const item of publications) {
      const event = new Event("track");
      Object.defineProperties(event, {
        track: {
          value: new FakeTrack(
            item.source === "screen_audio" ? "audio" : "video",
          ),
        },
        transceiver: { value: { mid: item.id } },
      });
      peers[1]!.dispatchEvent(event);
    }
    session.selectScreen(screen.id);
    session.showVideo(true, true);
    await vi.waitFor(() => expect(session.remoteMedia()).toHaveLength(3));
    session.showVideo(false, true);
    await vi.waitFor(() =>
      expect(requests.at(-1)).toEqual(["screen", "screen-audio"]),
    );
    expect(session.remoteMedia().map((item) => item.publication.id)).toEqual([
      "screen",
      "screen-audio",
    ]);
    session.showVideo(false, false);
    await vi.waitFor(() => expect(requests.at(-1)).toEqual([]));
    expect(session.remoteMedia()).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
    session.dispose();
  });

  it("hides playback during a pending subscription, excludes later publications and restores reception explicitly", async () => {
    const gate = deferred<void>();
    const microphone = publication("microphone", "microphone");
    const camera = publication("camera", "camera");
    const subscriptions: string[][] = [];
    const calls: string[] = [];
    const rpc: MediaTransport = async (path, body) => {
      calls.push(path);
      const command = body as {
        operationId: string;
        publicationIds?: string[];
      };
      if (path === "subscribe") {
        const ids = command.publicationIds!;
        subscriptions.push(ids);
        if (subscriptions.length === 1)
          return {
            kind: "negotiation",
            operationId: command.operationId,
            sessionVersion: 1,
            phase: "awaiting_answer",
            sessionDescription: { type: "offer", sdp: "offer" },
            publications: [],
            subscriptions: [{ publication: microphone, mid: "0" }],
            deadline: Date.now() + 10_000,
          };
        return {
          kind: "completed",
          operationId: command.operationId,
          sessionVersion: subscriptions.length + 1,
          revision: 1,
          subscriptions: ids.map((id) => ({
            publication: id === microphone.id ? microphone : camera,
            mid: id === microphone.id ? "0" : "1",
          })),
        };
      }
      await gate.promise;
      return {
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: 2,
        revision: 1,
        subscriptions: [{ publication: microphone, mid: "0" }],
      };
    };
    const { session, peers, failed } = sessionHarness(
      rpc,
      snapshot([microphone]),
    );
    session.showVideo(true, true);
    await vi.waitFor(() => expect(calls).toEqual(["subscribe", "answer"]));
    expect(peers[1]!.localDescription).not.toBeNull();
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: new FakeTrack("audio") },
      transceiver: { value: { mid: "0" } },
    });
    peers[1]!.dispatchEvent(event);
    expect(session.remoteMedia().map((item) => item.publication.id)).toEqual([
      "microphone",
    ]);
    session.setHiddenUsers(["peer"]);
    expect(session.remoteMedia()).toEqual([]);
    session.updateSnapshot({ ...snapshot([microphone, camera]), revision: 2 });
    await flush();
    expect(calls).toEqual(["subscribe", "answer"]);
    expect(subscriptions).toEqual([["microphone"]]);
    gate.resolve();
    await vi.waitFor(() => expect(subscriptions).toEqual([["microphone"], []]));
    expect(calls).toEqual(["subscribe", "answer", "subscribe"]);
    expect(session.remoteMedia()).toEqual([]);
    session.setHiddenUsers([]);
    await vi.waitFor(() =>
      expect(subscriptions.at(-1)).toEqual(["camera", "microphone"]),
    );
    expect(session.remoteMedia().map((item) => item.publication.id)).toEqual([
      "microphone",
    ]);
    expect(failed).not.toHaveBeenCalled();
    session.dispose();
  });
  it("applies a retained choice when a participant arrives or returns under a new participant ID", async () => {
    const calls: string[][] = [];
    const rpc: MediaTransport = async (_path, body) => {
      const command = body as { operationId: string; publicationIds: string[] };
      calls.push(command.publicationIds);
      return {
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: calls.length,
        revision: 1,
        subscriptions: [],
      };
    };
    const { session } = sessionHarness(rpc, {
      ...snapshot(),
      participants: [participant("self")],
    });
    session.setHiddenUsers(["peer"]);
    session.showVideo(true, true);
    session.updateSnapshot({
      ...snapshot(),
      revision: 2,
      participants: [
        participant("self"),
        {
          ...participant("returned", [
            publication("new-mic", "microphone", "returned"),
          ]),
          userId: "peer",
        },
      ],
    });
    await flush();
    expect(calls).toEqual([]);
    session.setHiddenUsers([]);
    await vi.waitFor(() => expect(calls).toEqual([["new-mic"]]));
    session.dispose();
  });
});

describe("session queue ownership", () => {
  it("serializes across rejected work without stranding the next operation", async () => {
    const queue = new SessionQueue();
    const gate = deferred<void>();
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push("first");
      await gate.promise;
      throw new Error("failure");
    });
    const rejected = expect(first).rejects.toThrow("failure");
    const second = queue.run(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    gate.resolve();
    await rejected;
    await second;
    expect(order).toEqual(["first", "second"]);
  });
  it("holds the publishing queue through remote apply, connection readiness and backend ACK", async () => {
    const applied = deferred<void>();
    const ack = deferred<MediaOutcome>();
    const calls: string[] = [];
    const rpc: MediaTransport = async (path, body) => {
      calls.push(path);
      const command = body as { operationId: string };
      if (path === "publish")
        return {
          kind: "negotiation",
          operationId: command.operationId,
          sessionVersion: 1,
          phase: "awaiting_apply",
          sessionDescription: { type: "answer", sdp: "answer" },
          publications: [],
          subscriptions: [],
          deadline: Date.now() + 10_000,
        };
      if (path === "ack")
        return ack.promise.then(() => ({
          kind: "completed",
          operationId: command.operationId,
          sessionVersion: 1,
          revision: 1,
        }));
      return {
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: 2,
        revision: 2,
      };
    };
    const { session, peers } = sessionHarness(rpc);
    peers[0]!.remoteGate = applied.promise;
    peers[0]!.autoConnect = false;
    const track = new FakeTrack();
    const publishing = session.publish([
      { source: "microphone", track: track as unknown as MediaStreamTrack },
    ]);
    await vi.waitFor(() => expect(calls).toEqual(["publish"]));
    const stopping = session.stopSources(["microphone"]);
    expect(track.stopped).toBe(1);
    applied.resolve();
    await vi.waitFor(() => expect(peers[0]!.remoteDescription).not.toBeNull());
    expect(calls).toEqual(["publish"]);
    peers[0]!.connect();
    await vi.waitFor(() => expect(calls).toEqual(["publish", "ack"]));
    expect(calls).not.toContain("unpublish");
    ack.resolve({ kind: "unavailable" });
    await publishing;
    await stopping;
    expect(calls).toEqual(["publish", "ack", "unpublish"]);
    session.dispose();
  });
  it("maps subscriptions completed without an offer and replaces the map on removal", async () => {
    const microphone = publication("microphone", "microphone");
    const camera = publication("camera", "camera");
    const calls: string[][] = [];
    const rpc: MediaTransport = async (_path, body) => {
      const command = body as { operationId: string; publicationIds: string[] };
      calls.push(command.publicationIds);
      return {
        kind: "completed",
        operationId: command.operationId,
        sessionVersion: calls.length,
        revision: calls.length,
        subscriptions: command.publicationIds.map((id) => ({
          publication: id === microphone.id ? microphone : camera,
          mid: id === microphone.id ? "0" : "1",
        })),
      };
    };
    const { session, peers, failed } = sessionHarness(
      rpc,
      snapshot([microphone, camera]),
    );
    const microphoneTrack = new FakeTrack("audio");
    const cameraTrack = new FakeTrack("video");
    for (const [mid, track] of [
      ["0", microphoneTrack],
      ["1", cameraTrack],
    ] as const) {
      const event = new Event("track");
      Object.defineProperties(event, {
        track: { value: track },
        transceiver: { value: { mid } },
      });
      peers[1]!.dispatchEvent(event);
    }
    session.showVideo(true, true);
    await vi.waitFor(() =>
      expect(
        session
          .remoteMedia()
          .map((item) => item.publication.id)
          .sort(),
      ).toEqual(["camera", "microphone"]),
    );
    expect(peers[1]!.remoteDescription).toBeNull();
    session.updateSnapshot({ ...snapshot([camera]), revision: 2 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(session.remoteMedia().map((item) => item.publication.id)).toEqual([
      "camera",
    ]);
    session.showVideo(false, false);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toEqual([]);
    expect(session.remoteMedia()).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
    session.dispose();
  });
  it.each([false, true])(
    "replaces the offer mapping with the final answer mapping (empty: %s)",
    async (empty) => {
      const camera = publication("camera", "camera");
      const answerGate = deferred<void>();
      const rpc: MediaTransport = async (path, body) => {
        const command = body as { operationId: string };
        if (path === "subscribe")
          return {
            kind: "negotiation",
            operationId: command.operationId,
            sessionVersion: 1,
            phase: "awaiting_answer",
            sessionDescription: { type: "offer", sdp: "offer" },
            publications: [],
            subscriptions: [{ publication: camera, mid: "old" }],
            deadline: Date.now() + 10_000,
          };
        await answerGate.promise;
        return {
          kind: "completed",
          operationId: command.operationId,
          sessionVersion: 1,
          revision: 1,
          subscriptions: empty ? [] : [{ publication: camera, mid: "new" }],
        };
      };
      const { session, peers, failed } = sessionHarness(
        rpc,
        snapshot([camera]),
      );
      const oldTrack = new FakeTrack("video");
      const newTrack = new FakeTrack("video");
      for (const [mid, track] of [
        ["old", oldTrack],
        ["new", newTrack],
      ] as const) {
        const event = new Event("track");
        Object.defineProperties(event, {
          track: { value: track },
          transceiver: { value: { mid } },
        });
        peers[1]!.dispatchEvent(event);
      }
      session.showVideo(true, true);
      await vi.waitFor(() =>
        expect(session.remoteMedia()[0]?.stream.getTracks()[0]).toBe(oldTrack),
      );
      answerGate.resolve();
      await vi.waitFor(() => {
        if (empty) expect(session.remoteMedia()).toEqual([]);
        else
          expect(session.remoteMedia()[0]?.stream.getTracks()[0]).toBe(
            newTrack,
          );
      });
      expect(failed).not.toHaveBeenCalled();
      session.dispose();
    },
  );
  it("detaches retired playback before replacement and rejects delayed tracks, results and snapshots", async () => {
    const first = publication("old-microphone", "microphone");
    const next = {
      ...publication("new-microphone", "microphone"),
      generation: 2,
    };
    const lateAnswer = deferred<void>();
    let calls = 0;
    const { session, peers, failed } = sessionHarness(
      async (path, body) => {
        const command = body as {
          operationId: string;
          publicationIds: string[];
        };
        if (path === "answer") {
          await lateAnswer.promise;
          return {
            kind: "completed",
            operationId: command.operationId,
            sessionVersion: 1,
            revision: 1,
            subscriptions: [{ publication: first, mid: "old" }],
          };
        }
        calls++;
        return calls === 1
          ? {
              kind: "negotiation",
              operationId: command.operationId,
              sessionVersion: 1,
              phase: "awaiting_answer",
              sessionDescription: { type: "offer", sdp: "offer" },
              publications: [],
              subscriptions: [{ publication: first, mid: "old" }],
              deadline: Date.now() + 10_000,
            }
          : {
              kind: "completed",
              operationId: command.operationId,
              sessionVersion: 2,
              revision: 2,
              subscriptions: [{ publication: next, mid: "new" }],
            };
      },
      snapshot([first]),
    );
    const receive = (mid: string) => {
      const track = new FakeTrack();
      const event = new Event("track");
      Object.defineProperties(event, {
        track: { value: track },
        transceiver: { value: { mid } },
      });
      peers[1]!.dispatchEvent(event);
      return track;
    };
    session.reconcile();
    await flush();
    const oldTrack = receive("old");
    const oldStream = session.remoteMedia()[0]!.stream;
    expect(oldTrack.enabled).toBe(true);
    const replacement = snapshot([next]);
    replacement.revision = 2;
    replacement.participants[1]!.generation = 2;
    session.updateSnapshot(replacement);
    expect(oldTrack.enabled).toBe(false);
    expect(oldTrack.readyState).toBe("live");
    expect(oldStream.getTracks()).toEqual([]);
    expect(session.remoteMedia()).toEqual([]);
    expect(calls).toBe(1); // The old answer still owns the consumer mutation queue.
    const delayedOld = receive("old");
    expect(delayedOld.enabled).toBe(false);
    session.updateSnapshot(snapshot([first]));
    expect(session.snapshot).toBe(replacement);
    lateAnswer.resolve();
    await flush();
    expect(calls).toBe(2);
    const newTrack = receive("new");
    expect(newTrack.enabled).toBe(true);
    expect(session.remoteMedia().map((item) => item.publication)).toEqual([
      next,
    ]);
    const laterOld = receive("old");
    expect(laterOld.enabled).toBe(false);
    expect(session.remoteMedia().map((item) => item.publication)).toEqual([
      next,
    ]);
    expect(failed).not.toHaveBeenCalled();
    session.dispose();
  });
  it("reuses a receiver MID without reviving its retired playback stream", async () => {
    const first = publication("first-microphone", "microphone");
    const next = {
      ...publication("second-microphone", "microphone"),
      generation: 2,
    };
    let selected = first;
    const { session, peers, failed } = sessionHarness(
      async (_path, body) => {
        const command = body as {
          operationId: string;
          expectedSessionVersion: number;
        };
        return {
          kind: "completed",
          operationId: command.operationId,
          sessionVersion: command.expectedSessionVersion + 1,
          revision: 1,
          subscriptions: [{ publication: selected, mid: "reused" }],
        };
      },
      snapshot([first]),
    );
    session.reconcile();
    await flush();
    const track = new FakeTrack();
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: track },
      transceiver: { value: { mid: "reused" } },
    });
    peers[1]!.dispatchEvent(event);
    const retiredStream = session.remoteMedia()[0]!.stream;
    const replacement = snapshot([next]);
    replacement.revision = 2;
    replacement.participants[1]!.generation = 2;
    selected = next;
    session.updateSnapshot(replacement);
    expect(track.enabled).toBe(false);
    expect(retiredStream.getTracks()).toEqual([]);
    await flush();
    const current = session.remoteMedia()[0]!;
    expect(current.publication).toEqual(next);
    expect(current.stream).not.toBe(retiredStream);
    expect(current.stream.getTracks()).toEqual([track]);
    expect(retiredStream.getTracks()).toEqual([]);
    expect(track.enabled).toBe(true);
    expect(track.stopped).toBe(0);
    expect(failed).not.toHaveBeenCalled();
    session.dispose();
    expect(track.stopped).toBe(1);
  });
  it("disposes tracks and endpoints, and never ACKs an answer arriving after replacement", async () => {
    const response = deferred<Extract<MediaOutcome, { kind: "negotiation" }>>();
    const calls: string[] = [];
    let operationId = "";
    const { session, peers } = sessionHarness(async (path, body) => {
      calls.push(path);
      operationId = (body as { operationId: string }).operationId;
      return response.promise;
    });
    const track = new FakeTrack();
    const pending = session.publish([
      { source: "camera", track: track as unknown as MediaStreamTrack },
    ]);
    const rejected = expect(pending).rejects.toBeInstanceOf(ReplacedGeneration);
    await vi.waitFor(() => expect(calls).toEqual(["publish"]));
    session.dispose();
    response.resolve({
      kind: "negotiation",
      operationId,
      sessionVersion: 1,
      phase: "awaiting_apply",
      sessionDescription: { type: "answer", sdp: "late" },
      publications: [],
      subscriptions: [],
      deadline: Date.now() + 10_000,
    });
    await rejected;
    expect(peers.every((peer) => peer.closed)).toBe(true);
    expect(peers[0]!.remoteDescription).toBeNull();
    expect(track.stopped).toBeGreaterThan(0);
    expect(calls).not.toContain("ack");
  });
});
