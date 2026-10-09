import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MediaController } from "@/client/features/media/controller";
import { MediaContext } from "@/client/features/media/context";
import { MediaPlayback } from "@/client/features/media/playback";
import { MediaSession } from "@/client/features/media/session";
import { mediaApiContract } from "@vaskel/contracts/api";
import {
  AnswerMediaRequestSchema,
  SubscribeMediaRequestSchema,
  type MediaPublication,
  type MediaSnapshot,
  type MediaSource,
} from "@vaskel/contracts/media";

const sources: MediaSource[] = [
  "microphone",
  "camera",
  "screen_video",
  "screen_audio",
];

/** Real receiver/React playback, with a local browser peer standing in for SFU SDP. */
export async function createMediaProof(reuseMids = false) {
  const room = {
    owner: { kind: "server" as const, id: "room" },
    channelId: "voice",
  };
  const handle = {
    room,
    participantId: "listener",
    accountGeneration: 1,
    clientId: crypto.randomUUID(),
    deviceToken: "a".repeat(64),
  };
  const publisher = new RTCPeerConnection({ iceServers: [] });
  const context = new AudioContext();
  await context.resume();
  const tracks = new Map<
    string,
    {
      publication: MediaPublication;
      track: MediaStreamTrack;
      transceiver: RTCRtpTransceiver;
    }
  >();
  const generations = new Map<number, MediaPublication[]>();
  const timers: ReturnType<typeof setInterval>[] = [];
  const oscillators: OscillatorNode[] = [];
  const events: {
    action: string;
    generation: number | null;
    attached: number[];
  }[] = [];
  const elements = new Set<HTMLMediaElement>();
  const streamGenerations = new WeakMap<MediaStream, number>();
  const failures: string[] = [];
  const requests: number[][] = [];
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "srcObject",
  )!;
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get: descriptor.get!,
    set(this: HTMLMediaElement, value: MediaStream | null) {
      elements.add(this);
      descriptor.set!.call(this, value);
      events.push({
        action: value ? "attach" : "detach",
        generation: value ? (streamGenerations.get(value) ?? null) : null,
        attached: [
          ...new Set(
            [...elements].flatMap((element) => {
              const stream = element.srcObject;
              return stream instanceof MediaStream &&
                streamGenerations.has(stream)
                ? [streamGenerations.get(stream)!]
                : [];
            }),
          ),
        ],
      });
    },
  });
  function publications(generation: number) {
    let result = generations.get(generation);
    if (result) return result;
    result = sources.map((source) => ({
      id: crypto.randomUUID(),
      participantId: "speaker",
      generation,
      source,
    }));
    generations.set(generation, result);
    return result;
  }
  function snapshot(generation: number): MediaSnapshot {
    const base = {
      controlVersion: 0,
      muted: false,
      deafened: false,
      screenRevoked: false,
      status: "active" as const,
    };
    return {
      room,
      revision: generation,
      participants: [
        {
          ...base,
          id: "listener",
          userId: "listener",
          generation: 1,
          publications: [],
        },
        {
          ...base,
          id: "speaker",
          userId: "speaker",
          generation,
          publications: publications(generation),
        },
      ],
    };
  }
  async function addTrack(publication: MediaPublication) {
    if (tracks.has(publication.id)) return;
    let track: MediaStreamTrack;
    if (
      publication.source === "microphone" ||
      publication.source === "screen_audio"
    ) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220 + publication.generation * 110;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      oscillators.push(oscillator);
      track = destination.stream.getAudioTracks()[0]!;
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const drawing = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        drawing.fillStyle = `hsl(${publication.generation * 60 + (frame++ % 30)} 70% 50%)`;
        drawing.fillRect(0, 0, 64, 64);
      };
      draw();
      timers.push(setInterval(draw, 40));
      track = canvas.captureStream(25).getVideoTracks()[0]!;
    }
    const previous = reuseMids
      ? [...tracks.values()].find(
          (item) => item.publication.source === publication.source,
        )
      : undefined;
    const transceiver =
      previous?.transceiver ??
      publisher.addTransceiver(track, {
        direction: "sendonly",
        streams: [new MediaStream([track])],
      });
    if (previous) {
      await transceiver.sender.replaceTrack(track);
      transceiver.sender.setStreams(new MediaStream([track]));
    }
    tracks.set(publication.id, { publication, track, transceiver });
  }
  let releaseOffer: (() => void) | undefined;
  let holdNext = false;
  let held = false;
  let version = 0;
  let negotiated: MediaPublication[] = [];
  const mount = document.createElement("main");
  document.body.append(mount);
  const root = createRoot(mount);
  // The real controller owns output registration; session callbacks drive this focused stage.
  const controller = new MediaController("listener", location.origin, false);
  const render = () => {
    const remote = session.remoteMedia();
    for (const item of remote)
      streamGenerations.set(item.stream, item.publication.generation);
    root.render(
      createElement(
        MediaContext,
        { value: controller },
        remote.map(({ publication, stream }) =>
          createElement(MediaPlayback, {
            key: publication.id,
            stream,
            audio:
              publication.source === "microphone" ||
              publication.source === "screen_audio",
            label: `${publication.generation}:${publication.source}`,
          }),
        ),
      ),
    );
  };
  const session = new MediaSession(
    handle,
    0,
    0,
    snapshot(1),
    async (path, body) => {
      if (path === "subscribe") {
        const request = SubscribeMediaRequestSchema.parse(body);
        negotiated = [...generations.values()]
          .flat()
          .filter((publication) =>
            request.publicationIds.includes(publication.id),
          );
        requests.push(negotiated.map((publication) => publication.generation));
        for (const publication of negotiated) await addTrack(publication);
        // The default fixture retains old senders and live RTP without a close acknowledgement.
        await publisher.setLocalDescription(await publisher.createOffer());
        if (publisher.iceGatheringState !== "complete")
          await new Promise<void>((resolve) => {
            const changed = () => {
              if (publisher.iceGatheringState !== "complete") return;
              publisher.removeEventListener("icegatheringstatechange", changed);
              resolve();
            };
            publisher.addEventListener("icegatheringstatechange", changed);
            changed();
          });
        const result = mediaApiContract.subscribeMedia[
          "~orpc"
        ].outputSchema!.parse({
          kind: "negotiation",
          operationId: request.operationId,
          sessionVersion: ++version,
          phase: "awaiting_answer",
          publications: [],
          deadline: Date.now() + 30_000,
          sessionDescription: {
            type: "offer",
            sdp: publisher.localDescription!.sdp,
          },
          subscriptions: negotiated.map((publication) => ({
            publication,
            mid: tracks.get(publication.id)!.transceiver.mid,
          })),
        });
        if (holdNext) {
          holdNext = false;
          held = true;
          await new Promise<void>((resolve) => {
            releaseOffer = resolve;
          });
          held = false;
        }
        return result;
      }
      if (path === "answer") {
        const request = AnswerMediaRequestSchema.parse(body);
        await publisher.setRemoteDescription(request.sessionDescription);
        return mediaApiContract.answerMedia["~orpc"].outputSchema!.parse({
          kind: "completed",
          operationId: request.operationId,
          sessionVersion: ++version,
          revision: session.snapshot.revision,
          subscriptions: negotiated.map((publication) => ({
            publication,
            mid: tracks.get(publication.id)!.transceiver.mid,
          })),
        });
      }
      throw new Error(`Unexpected media operation: ${path}`);
    },
    {
      changed: render,
      failed: (error) => failures.push(String(error)),
      sourceEnded: () => {},
      connection: () => {},
    },
    () => new RTCPeerConnection({ iceServers: [] }),
  );
  function advance(generation: number) {
    session.updateSnapshot(snapshot(generation));
    session.selectScreen(
      publications(generation).find(
        (publication) => publication.source === "screen_video",
      )!.id,
    );
  }
  session.showVideo(true, true);
  session.selectScreen(
    publications(1).find(
      (publication) => publication.source === "screen_video",
    )!.id,
  );
  return {
    advance,
    staleSnapshot(generation: number) {
      session.updateSnapshot(snapshot(generation));
    },
    hold() {
      holdNext = true;
    },
    release() {
      releaseOffer?.();
      releaseOffer = undefined;
    },
    lateTrack(generation: number) {
      for (const transceiver of session.consumer.getTransceivers()) {
        const source = [...tracks.values()].find(
          (item) => item.transceiver.mid === transceiver.mid,
        );
        if (source?.publication.generation !== generation) continue;
        session.consumer.dispatchEvent(
          new RTCTrackEvent("track", {
            receiver: transceiver.receiver,
            transceiver,
            track: transceiver.receiver.track,
            streams: [],
          }),
        );
      }
    },
    state() {
      return {
        held,
        failures,
        requests,
        events,
        revision: session.snapshot.revision,
        roster: session.snapshot.participants.filter(
          (participant) => participant.userId === "speaker",
        ).length,
        connected: publisher.connectionState,
        receivers: session.consumer.getTransceivers().map((transceiver) => ({
          mid: transceiver.mid,
          track: transceiver.receiver.track.id,
          state: transceiver.receiver.track.readyState,
        })),
        playback: [
          ...document.querySelectorAll<HTMLMediaElement>("audio, video"),
        ].map((element) => ({
          label: element.getAttribute("aria-label"),
          paused: element.paused,
          attached: element.srcObject instanceof MediaStream,
          ready: element.readyState,
          time: element.currentTime,
        })),
        senders: [...tracks.values()].map(({ publication, track }) => ({
          generation: publication.generation,
          state: track.readyState,
        })),
      };
    },
    async bytes(generation: number) {
      let bytes = 0;
      for (const { publication, transceiver } of tracks.values()) {
        if (publication.generation !== generation) continue;
        (await transceiver.sender.getStats()).forEach((report) => {
          if (report.type === "outbound-rtp")
            bytes += Number(report.bytesSent ?? 0);
        });
      }
      return bytes;
    },
    async close() {
      releaseOffer?.();
      root.unmount();
      session.dispose();
      controller.dispose();
      publisher.close();
      for (const { track } of tracks.values()) track.stop();
      for (const timer of timers) clearInterval(timer);
      for (const oscillator of oscillators) oscillator.stop();
      await context.close();
      Object.defineProperty(
        HTMLMediaElement.prototype,
        "srcObject",
        descriptor,
      );
      mount.remove();
    },
  };
}

export type MediaProof = Awaited<ReturnType<typeof createMediaProof>>;
declare global {
  interface Window {
    mediaProof: MediaProof;
  }
}

export { createDeviceProof } from "@tests/e2e/media-device-fixture";
