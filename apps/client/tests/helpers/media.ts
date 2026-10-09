import { failureResponse } from "@tests/helpers/http";
import { vi } from "vitest";
import {
  MediaOutcomeSchema,
  MediaFailureSchema,
  type MediaHandle,
  type MediaOutcome,
  type MediaPublication,
  type MediaSnapshot,
} from "@vaskel/contracts/media";
import {
  MediaSession,
  type MediaTransport,
} from "@/client/features/media/session";

export const room = {
  owner: { kind: "server" as const, id: "room" },
  channelId: "channel",
};

export const handle: MediaHandle = {
  room,
  participantId: "self",
  accountGeneration: 1,
  clientId: "11111111-1111-4111-8111-111111111111",
  deviceToken: "a".repeat(64),
};

export const publication = (
  id: string,
  source: MediaPublication["source"],
  participantId = "peer",
): MediaPublication => ({ id, source, participantId, generation: 1 });

export const participant = (
  id: string,
  publications: MediaPublication[] = [],
) => ({
  id,
  userId: id,
  generation: 1,
  controlVersion: 0,
  muted: false,
  deafened: false,
  screenRevoked: false,
  status: "active" as const,
  publications,
});

export const snapshot = (pubs: MediaPublication[] = []): MediaSnapshot => ({
  room,
  revision: 1,
  participants: [participant("self"), participant("peer", pubs)],
});

export async function flush() {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve, 0));
}

export function wireResponse(outcome: MediaOutcome, status?: number) {
  if (
    MediaFailureSchema.safeParse(outcome).success &&
    outcome.kind !== "cleanup_pending"
  )
    return failureResponse(outcome, status === undefined ? {} : { status });
  return Response.json(MediaOutcomeSchema.parse(outcome), {
    status: status ?? 200,
  });
}

export class FakeTrack extends EventTarget {
  kind: string;
  enabled = true;
  readyState = "live";
  stopped = 0;
  constructor(kind = "audio") {
    super();
    this.kind = kind;
  }
  stop() {
    this.stopped++;
    this.readyState = "ended";
  }
}

export class FakeStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  removeTrack(track: MediaStreamTrack) {
    const index = this.tracks.indexOf(track);
    if (index !== -1) this.tracks.splice(index, 1);
  }
}

class FakeAudioContext {
  state = "running";
  sampleRate = 48_000;
  track = new FakeTrack();
  destination = { speaker: true };
  output = {
    stream: new FakeStream([this.track as unknown as MediaStreamTrack]),
    disconnect: vi.fn(),
  };
  source = {
    buffer: null as unknown,
    loop: false,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  };
  createMediaStreamDestination = () => this.output;
  createBufferSource = () => this.source;
  createBuffer = vi.fn(
    (_channels: number, length: number) => new Float32Array(length),
  );
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
}

export function audioContexts(suspended = false) {
  const contexts: FakeAudioContext[] = [];
  vi.stubGlobal(
    "AudioContext",
    class extends FakeAudioContext {
      constructor() {
        super();
        if (suspended) {
          this.state = "suspended";
          this.resume = vi.fn(() => new Promise<void>(() => {}));
        }
        contexts.push(this);
      }
    },
  );
  return contexts;
}

export class FakePeer extends EventTarget {
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "complete";
  autoGather = true;
  autoConnect = true;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  remoteGate: Promise<void> | null = null;
  transceivers: Array<{
    mid: string;
    sender: { track: MediaStreamTrack; replaceTrack: ReturnType<typeof vi.fn> };
    direction: RTCRtpTransceiverDirection | undefined;
    stop: () => void;
  }> = [];
  closed = false;
  addTransceiver(track: MediaStreamTrack, options: RTCRtpTransceiverInit) {
    const sender = {
      track,
      replaceTrack: vi.fn(async (next: MediaStreamTrack) => {
        sender.track = next;
      }),
    };
    const transceiver = {
      mid: String(this.transceivers.length),
      sender,
      direction: options.direction,
      stop: () => {},
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  removeTrack() {}
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    return { type: "offer" as const, sdp: "offer" };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "answer" };
  }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    if (sdp.type === "rollback") {
      this.localDescription = null;
      return;
    }
    this.localDescription = sdp;
    if (!this.autoGather) this.iceGatheringState = "gathering";
  }
  completeGather(sdp: string) {
    this.localDescription = { ...this.localDescription!, sdp };
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }
  connect(state = "connected") {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    await this.remoteGate;
    this.remoteDescription = sdp;
    if (this.autoConnect) this.connect();
  }
  close() {
    this.closed = true;
    this.connect("closed");
  }
}

export function sessionHarness(
  transport: MediaTransport,
  initial = snapshot(),
) {
  const peers: FakePeer[] = [];
  const failed = vi.fn();
  const changed = vi.fn();
  const connection = vi.fn();
  const sourceEnded = vi.fn();
  const session = new MediaSession(
    handle,
    0,
    0,
    initial,
    transport,
    { changed, failed, sourceEnded, connection },
    () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
  );
  return { session, peers, failed, changed, connection, sourceEnded };
}
