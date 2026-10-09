import { MediaController } from "@/client/features/media/controller";
import { gatheredLocalDescription } from "@/client/features/media/readiness";
import {
  AckMediaRequestSchema,
  JoinMediaRequestSchema,
  ResumeMediaRequestSchema,
  MediaOutcomeSchema,
  PublishMediaRequestSchema,
  UnpublishMediaRequestSchema,
  type MediaPublication,
  type MediaHandle,
  type MediaSnapshot,
} from "@vaskel/contracts/media";

/** Production controller/capture/session with native peers and synthetic HTTP signaling. */
export async function createDeviceProof(
  options: {
    muted?: boolean;
    camera?: boolean;
    nativeMicrophone?: boolean;
    suspended?: boolean;
    inherited?: boolean;
  } = {},
) {
  const NativePeer = RTCPeerConnection;
  const nativeFetch = window.fetch;
  const nativeCapture = navigator.mediaDevices.getUserMedia;
  const NativeAudioContext = AudioContext;
  const peers: RTCPeerConnection[] = [];
  let offers = 0;
  window.RTCPeerConnection = class extends NativePeer {
    constructor() {
      super({ iceServers: [], bundlePolicy: "max-bundle" });
      peers.push(this);
      this.createOffer = ((options?: RTCOfferOptions) => {
        offers++;
        return super.createOffer(options);
      }) as typeof this.createOffer;
    }
  };
  const receiver = new NativePeer({
    iceServers: [],
    bundlePolicy: "max-bundle",
  });
  const audio = new AudioContext();
  if (!options.inherited) await audio.resume();
  let activationAllowed = !options.suspended;
  const sourceContexts: AudioContext[] = [];
  window.AudioContext = class extends NativeAudioContext {
    constructor(contextOptions?: AudioContextOptions) {
      super(contextOptions);
      sourceContexts.push(this);
      if (!activationAllowed) void super.suspend();
    }
    override resume() {
      return activationAllowed ? super.resume() : new Promise<void>(() => {});
    }
  };
  const oscillators: OscillatorNode[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const captures: MediaStreamTrack[] = [];
  const calls: string[] = [];
  let captureRequests = 0;
  let denyCapture = false;
  const senderIds = new Map<RTCRtpSender, number>();
  const publications: MediaPublication[] = [];
  const room = {
    owner: { kind: "server" as const, id: "room" },
    channelId: "voice",
  };
  const handle: MediaHandle = {
    room,
    participantId: "publisher",
    accountGeneration: 1,
    clientId: crypto.randomUUID(),
    deviceToken: "a".repeat(64),
  };
  const snapshot = (): MediaSnapshot => ({
    room,
    revision: 1,
    participants: [
      {
        id: handle.participantId,
        userId: "publisher",
        generation: 1,
        controlVersion: 0,
        status: "active",
        muted: false,
        deafened: false,
        screenRevoked: false,
        publications: [...publications],
      },
    ],
  });
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  const sink = document.createElement("audio");
  sink.muted = true;
  sink.autoplay = true;
  document.body.append(video, sink);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 8192;
  let analysisSource: MediaStreamAudioSourceNode | undefined;
  receiver.addEventListener("track", ({ track }) => {
    const stream = new MediaStream([track]);
    if (track.kind === "video") video.srcObject = stream;
    else {
      sink.srcObject = stream;
      analysisSource?.disconnect();
      analysisSource = audio.createMediaStreamSource(stream);
      analysisSource.connect(analyser);
      const silence = audio.createGain();
      silence.gain.value = 0;
      analyser.connect(silence).connect(audio.destination);
    }
    void (track.kind === "video" ? video : sink).play();
  });
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    captureRequests++;
    if (denyCapture)
      throw new DOMException("Synthetic permission denial", "NotAllowedError");
    if (options.nativeMicrophone && constraints?.audio) {
      const stream = await nativeCapture.call(
        navigator.mediaDevices,
        constraints,
      );
      captures.push(...stream.getTracks());
      return stream;
    }
    const selection = constraints?.audio || constraints?.video;
    const device =
      typeof selection === "object" ? selection.deviceId : undefined;
    const index =
      typeof device === "object" && "exact" in device
        ? Number(device.exact)
        : 0;
    let track: MediaStreamTrack;
    if (constraints?.audio) {
      const oscillator = audio.createOscillator();
      oscillator.frequency.value = [440, 880, 660, 990][index]!;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      oscillators.push(oscillator);
      track = destination.stream.getAudioTracks()[0]!;
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 120;
      const drawing = canvas.getContext("2d")!;
      const draw = () => {
        drawing.fillStyle = [
          "rgb(240,20,20)",
          "rgb(20,240,20)",
          "rgb(20,20,240)",
          "rgb(240,240,20)",
        ][index]!;
        drawing.fillRect(0, 0, 160, 120);
      };
      draw();
      timers.push(setInterval(draw, 40));
      track = canvas.captureStream(25).getVideoTracks()[0]!;
    }
    captures.push(track);
    return new MediaStream([track]);
  };
  let version = 0;
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.split("/").at(-1)!;
    calls.push(path);
    const body: unknown = request.body ? await request.json() : undefined;
    if (path === "config")
      return Response.json({
        kind: "media_configuration",
        configured: true,
        maxParticipants: 16,
      });
    if (path === "status")
      return Response.json(
        MediaOutcomeSchema.parse({
          kind: "media_status",
          generation: 0,
          admission: { kind: "available" },
        }),
      );
    if (path === "join" || path === "resume") {
      const request =
        path === "join"
          ? JoinMediaRequestSchema.parse(body)
          : ResumeMediaRequestSchema.parse(body);
      handle.clientId =
        "clientId" in request ? request.clientId : request.handle.clientId;
      handle.deviceToken =
        "deviceToken" in request
          ? request.deviceToken
          : request.nextDeviceToken;
      return Response.json(
        MediaOutcomeSchema.parse({
          kind: "joined",
          handle,
          generation: 1,
          producerVersion: 0,
          consumerVersion: 0,
          snapshot: snapshot(),
        }),
      );
    }
    if (path === "publish") {
      const request = PublishMediaRequestSchema.parse(body);
      await receiver.setRemoteDescription(request.sessionDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      const description = await gatheredLocalDescription(
        receiver,
        new AbortController().signal,
      );
      for (const { source } of request.tracks)
        publications.push({
          id: crypto.randomUUID(),
          participantId: handle.participantId,
          generation: 1,
          source,
        });
      return Response.json(
        MediaOutcomeSchema.parse({
          kind: "negotiation",
          operationId: request.operationId,
          sessionVersion: ++version,
          phase: "awaiting_apply",
          sessionDescription: { type: "answer", sdp: description.sdp },
          publications: [...publications],
          subscriptions: [],
          deadline: Date.now() + 15_000,
        }),
      );
    }
    if (path === "ack" || path === "unpublish") {
      const request =
        path === "ack"
          ? AckMediaRequestSchema.parse(body)
          : UnpublishMediaRequestSchema.parse(body);
      if (path === "unpublish") {
        const { sources } = UnpublishMediaRequestSchema.parse(body);
        for (let index = publications.length - 1; index >= 0; index--)
          if (sources.includes(publications[index]!.source))
            publications.splice(index, 1);
      }
      return Response.json(
        MediaOutcomeSchema.parse({
          kind: "completed",
          operationId: request.operationId,
          sessionVersion: version,
          revision: 1,
        }),
      );
    }
    if (path === "heartbeat")
      return Response.json(
        MediaOutcomeSchema.parse({
          kind: "heartbeat",
          expiresAt: Date.now() + 30_000,
          snapshot: snapshot(),
        }),
      );
    if (path === "leave")
      return Response.json({
        kind: "left",
        generation: 2,
        cleanupPending: false,
      });
    throw new Error(`Unexpected synthetic signaling ${path}`);
  };
  sessionStorage.clear();
  if (options.muted)
    sessionStorage.setItem(
      `vaskel:call:${location.origin}:publisher:muted`,
      "true",
    );
  if (options.inherited)
    sessionStorage.setItem(
      `vaskel:call:${location.origin}:publisher`,
      JSON.stringify({
        room,
        label: "Inherited call",
        canModerate: false,
        handle,
        pending: null,
      }),
    );
  const controller = new MediaController("publisher", location.origin);
  if (options.inherited) controller.attach();
  else await controller.join(room, "Device proof");
  if (options.camera !== false) await controller.startDevice("camera");
  while (controller.getSnapshot().pendingSources.length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const sampling = document.createElement("canvas");
  sampling.width = sampling.height = 1;
  const drawing = sampling.getContext("2d")!;
  return {
    state() {
      const frequencies = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(frequencies);
      let maximum = 0;
      for (let index = 1; index < frequencies.length; index++)
        if (frequencies[index]! > frequencies[maximum]!) maximum = index;
      if (video.readyState >= 2) drawing.drawImage(video, 0, 0, 1, 1);
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return {
        peak: samples.reduce(
          (peak, sample) => Math.max(peak, Math.abs(sample)),
          0,
        ),
        captureRequests,
        muted: controller.getSnapshot().muted,
        blocked: controller.getSnapshot().playbackBlocked,
        phase: controller.getSnapshot().phase,
        contexts: sourceContexts.map(({ state }) => state),
        senders: peers[0]?.getSenders().map((sender) => {
          if (!senderIds.has(sender)) senderIds.set(sender, senderIds.size);
          return {
            id: senderIds.get(sender),
            track: sender.track?.id,
            state: sender.track?.readyState,
          };
        }),
        frequency: (maximum * audio.sampleRate) / analyser.fftSize,
        rgb: [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3),
        offers,
        calls: [...calls],
        publications: publications.map(({ id }) => id),
        mids: peers[0]?.getTransceivers().map(({ mid }) => mid),
        receivers: receiver.getReceivers().map(({ track }) => track.id),
        captures: captures.map(({ readyState }) => readyState),
        error: controller.getSnapshot().error,
        local: (controller.getSnapshot().session?.local ?? []).map(
          ({ source, stream }) => ({
            source,
            enabled: stream.getTracks()[0]?.enabled,
          }),
        ),
      };
    },
    async rtp() {
      const stats = await peers[0]!.getStats();
      let packets = 0;
      let bytes = 0;
      stats.forEach((report) => {
        if (report.type === "outbound-rtp" && report.kind === "audio") {
          packets += Number(report.packetsSent ?? 0);
          bytes += Number(report.bytesSent ?? 0);
        }
      });
      const incoming = await receiver.getStats();
      let received = 0;
      let samples = 0;
      let energy = 0;
      incoming.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          received += Number(report.packetsReceived ?? 0);
          samples += Number(report.totalSamplesReceived ?? 0);
          energy += Number(report.totalAudioEnergy ?? 0);
        }
      });
      return {
        time: performance.now(),
        packets,
        bytes,
        received,
        samples,
        energy,
      };
    },
    mute() {
      controller.toggleMute();
    },
    denyCapture(denied: boolean) {
      denyCapture = denied;
    },
    enableAudio() {
      activationAllowed = true;
      void audio.resume();
      controller.enableAudio();
    },
    async leave() {
      await controller.leave();
    },
    async switch(index: number, fallback = false) {
      if (fallback) {
        const sender = peers[0]!
          .getSenders()
          .find(({ track }) => track?.kind === "audio")!;
        const replace = sender.replaceTrack.bind(sender);
        sender.replaceTrack = async (track) => {
          sender.replaceTrack = replace;
          throw new DOMException(
            `Synthetic envelope rejection for ${track?.kind}`,
            "InvalidModificationError",
          );
        };
      }
      await controller.switchDevice("microphone", String(index));
      await controller.switchDevice("camera", String(index));
    },
    async close() {
      await controller.leave();
      controller.dispose();
      receiver.close();
      for (const track of captures) track.stop();
      for (const timer of timers) clearInterval(timer);
      for (const oscillator of oscillators) oscillator.stop();
      await audio.close();
      video.remove();
      sink.remove();
      window.fetch = nativeFetch;
      window.RTCPeerConnection = NativePeer;
      window.AudioContext = NativeAudioContext;
      navigator.mediaDevices.getUserMedia = nativeCapture;
    },
  };
}

declare global {
  interface Window {
    deviceProof: Awaited<ReturnType<typeof createDeviceProof>>;
  }
}
