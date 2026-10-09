import type { MediaTransport, MediaBody } from "./controller/transport";
import type { MediaHandle, MediaSnapshot } from "@vaskel/contracts/media";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import type { MediaPublication, MediaSource } from "@vaskel/contracts/media";
import {
  desiredPublications,
  expectMedia,
  MediaError,
  ReplacedGeneration,
  RosterUnavailable,
  SessionQueue,
} from "./protocol";
import { CaptureEnded, stopCapture, type CapturedTrack } from "./capture";
import { gatheredLocalDescription, waitForConnected } from "./readiness";

import type { MediaMethod } from "./controller/transport";
export type { MediaTransport } from "./controller/transport";
export interface RemoteMedia {
  publication: MediaPublication;
  stream: MediaStream;
}
export interface LocalMedia {
  source: MediaSource;
  stream: MediaStream;
}
/** One session's identity, roster and media, published together to call surfaces. */
export interface SessionView {
  snapshot: MediaSnapshot;
  participantId: string;
  local: LocalMedia[];
  remote: RemoteMedia[];
  selectedScreen: string | null;
}

interface LocalTrack extends CapturedTrack {
  sender: RTCRtpSender;
  ended: () => void;
}
export interface SessionCallbacks {
  changed: () => void;
  failed: (error: unknown) => void;
  sourceEnded: (source: MediaSource) => void;
  connection: () => void;
}

/** One pair of endpoints per account generation. No React lifecycle owns negotiations. */
export class MediaSession {
  readonly producer: RTCPeerConnection;
  readonly consumer: RTCPeerConnection;
  readonly abort = new AbortController();
  readonly producerQueue = new SessionQueue();
  readonly consumerQueue = new SessionQueue();
  private local = new Map<MediaSource, LocalTrack>();
  private replacements = new Set<CapturedTrack>();
  private received = new Map<string, MediaStreamTrack>();
  private streams = new WeakMap<MediaStreamTrack, MediaStream>();
  private subscriptions = new Map<string, MediaPublication>();
  private subscribedIds: string[] = [];
  private desired: MediaPublication[] = [];
  private reconcileScheduled = false;
  private disposed = false;
  private listeners: Array<() => void> = [];
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private connectedPeers = new WeakSet<RTCPeerConnection>();
  snapshot: MediaSnapshot;
  selectedScreen: string | null = null;
  private visible = { cameras: false, screen: false };
  private hiddenUserIds = new Set<string>();
  muted = true;
  constructor(
    readonly handle: MediaHandle,
    private producerVersion: number,
    private consumerVersion: number,
    snapshot: MediaSnapshot,
    private readonly transport: MediaTransport,
    private readonly callbacks: SessionCallbacks,
    createPeer: () => RTCPeerConnection = () =>
      new RTCPeerConnection({
        bundlePolicy: "max-bundle",
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      }),
  ) {
    this.snapshot = snapshot;
    this.producer = createPeer();
    try {
      this.consumer = createPeer();
    } catch (error) {
      this.producer.close();
      throw error;
    }
    const onTrack = (event: RTCTrackEvent) => {
      if (this.disposed) {
        event.track.stop();
        return;
      }
      const mid = event.transceiver.mid;
      event.track.enabled = false;
      if (mid !== null) {
        const previous = this.received.get(mid);
        if (previous && previous !== event.track) {
          previous.enabled = false;
          this.streams.get(previous)?.removeTrack(previous);
          this.streams.delete(previous);
        }
        this.received.set(mid, event.track);
      }
      this.syncPlayback();
      this.callbacks.changed();
    };
    this.consumer.addEventListener("track", onTrack);
    this.listeners.push(() =>
      this.consumer.removeEventListener("track", onTrack),
    );
    for (const peer of [this.producer, this.consumer]) {
      const onState = () => {
        if (this.disposed) return;
        if (peer.connectionState === "connected") this.connectedPeers.add(peer);
        const failed = [this.producer, this.consumer].some(
          (pc) =>
            pc.connectionState === "failed" || pc.connectionState === "closed",
        );
        const disconnected = [this.producer, this.consumer].some(
          (pc) => pc.connectionState === "disconnected",
        );
        if (failed) {
          this.callbacks.failed(
            new UiMessageError(message("media.connectionEnded")),
          );
          return;
        }
        this.callbacks.connection();
        if (disconnected && !this.connectionTimer)
          this.connectionTimer = setTimeout(() => {
            this.connectionTimer = undefined;
            if (!this.disposed)
              this.callbacks.failed(
                new UiMessageError(message("media.connectionInterrupted")),
              );
          }, 12_000);
        if (!disconnected && this.connectionTimer) {
          clearTimeout(this.connectionTimer);
          this.connectionTimer = undefined;
        }
      };
      peer.addEventListener("connectionstatechange", onState);
      this.listeners.push(() =>
        peer.removeEventListener("connectionstatechange", onState),
      );
    }
  }
  check() {
    if (this.disposed) throw new ReplacedGeneration();
  }
  get reconnecting() {
    return [this.producer, this.consumer].some(
      (peer) =>
        peer.connectionState === "disconnected" ||
        (peer.connectionState === "connecting" &&
          this.connectedPeers.has(peer)),
    );
  }
  async rpc<K extends MediaMethod>(path: K, body: MediaBody<K>) {
    this.check();
    const result = await this.transport(path, body, this.abort.signal);
    this.check();
    return result;
  }
  private stream(track: MediaStreamTrack) {
    let stream = this.streams.get(track);
    if (!stream) {
      stream = new MediaStream([track]);
      this.streams.set(track, stream);
    }
    return stream;
  }
  view(): SessionView {
    return {
      snapshot: this.snapshot,
      participantId: this.handle.participantId,
      local: this.localMedia(),
      remote: this.remoteMedia(),
      selectedScreen: this.selectedScreen,
    };
  }
  localMedia(): LocalMedia[] {
    return [...this.local.values()]
      .filter((item) => !item.synthetic)
      .map(({ source, track }) => ({
        source,
        stream: this.stream(track),
      }));
  }
  remoteMedia(): RemoteMedia[] {
    const allowed = new Set(this.desired.map((p) => p.id));
    return [...this.subscriptions].flatMap(([mid, publication]) => {
      const track = this.received.get(mid);
      return track && allowed.has(publication.id)
        ? [{ publication, stream: this.stream(track) }]
        : [];
    });
  }
  /** Apply reception choices before React can mount any replacement playback. */
  private syncPlayback() {
    const allowed = new Set(this.desired.map((publication) => publication.id));
    const current = new Set(
      this.snapshot.participants.flatMap((participant) =>
        participant.publications
          .filter(
            (publication) => publication.generation === participant.generation,
          )
          .map((publication) => publication.id),
      ),
    );
    for (const [mid, track] of this.received) {
      const publication = this.subscriptions.get(mid);
      track.enabled = Boolean(publication && allowed.has(publication.id));
      if (publication && !current.has(publication.id)) {
        this.streams.get(track)?.removeTrack(track);
        this.streams.delete(track);
        // An inactive m-section may reuse its receiver track. Keep that track
        // disabled until a current subscription maps it, without ending it.
      }
    }
  }
  hasSource(source: MediaSource) {
    return this.local.has(source);
  }
  hasDevice(source: MediaSource) {
    const item = this.local.get(source);
    return Boolean(item && !item.synthetic);
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    const item = this.local.get("microphone");
    if (item)
      item.track.enabled =
        Boolean(item.synthetic || !muted) && !this.self()?.muted;
    this.callbacks.changed();
  }
  private self() {
    return this.snapshot.participants.find(
      (p) => p.id === this.handle.participantId,
    );
  }
  async publish(
    captured: CapturedTrack[],
    current: () => boolean = () => true,
  ) {
    try {
      await this.producerQueue.run(() => this.publishTracks(captured, current));
    } catch (error) {
      stopCapture(captured);
      throw error;
    }
  }
  private async publishTracks(
    captured: CapturedTrack[],
    current: () => boolean,
  ) {
    this.check();
    if (!current()) throw new ReplacedGeneration();
    if (
      !captured.length ||
      captured.some((item) => item.track.readyState !== "live")
    )
      throw new CaptureEnded(message("media.captureEnded"));
    for (const item of captured) {
      if (this.local.has(item.source))
        throw new UiMessageError(message("media.sourceConnected"));
      item.track.enabled =
        item.source !== "microphone" ||
        (Boolean(item.synthetic || !this.muted) && !this.self()?.muted);
      const { sender } = this.producer.addTransceiver(item.track, {
        direction: "sendonly",
        streams: [new MediaStream([item.track])],
      });
      this.installLocalTrack(item, sender);
    }
    const offer = await this.producer.createOffer();
    this.check();
    await this.producer.setLocalDescription(offer);
    const description = await gatheredLocalDescription(
      this.producer,
      this.abort.signal,
    );
    this.check();
    const tracks = captured.map(({ source, track }) => {
      const transceiver = this.producer
        .getTransceivers()
        .find((t) => t.sender.track === track);
      if (!transceiver?.mid)
        throw new UiMessageError(message("media.deviceConnectionFailed"));
      return { source, mid: transceiver.mid };
    });
    const operationId = crypto.randomUUID();
    let response;
    try {
      response = await this.rpc("publish", {
        handle: this.handle,
        operationId,
        issuedAt: Date.now(),
        expectedSessionVersion: this.producerVersion,
        sessionDescription: {
          type: "offer",
          sdp: description.sdp,
        },
        tracks,
      });
    } catch (error) {
      if (
        error instanceof MediaError &&
        error.outcome.kind === "action_restricted"
      ) {
        // Preflight denial has not changed the provider session. Restore the
        // existing producer while this exchange still owns its queue.
        await this.producer.setLocalDescription({ type: "rollback" });
        this.check();
        for (const item of captured) this.removeLocalSource(item.source);
        this.callbacks.changed();
      }
      throw error;
    }
    const result = expectMedia(response, "negotiation");
    if (
      result.operationId !== operationId ||
      result.phase !== "awaiting_apply" ||
      result.sessionDescription.type !== "answer"
    )
      throw new UiMessageError(message("media.unexpectedAnswer"));
    await this.producer.setRemoteDescription(result.sessionDescription);
    await waitForConnected(this.producer, this.abort.signal, result.deadline);
    this.check();
    const completed = expectMedia(
      await this.rpc("ack", {
        handle: this.handle,
        operationId,
        expectedSessionVersion: result.sessionVersion,
      }),
      "completed",
    );
    if (completed.operationId !== operationId)
      throw new UiMessageError(message("media.acknowledgementChanged"));
    this.producerVersion = completed.sessionVersion;
    this.callbacks.changed();
  }
  private installLocalTrack(item: CapturedTrack, sender: RTCRtpSender) {
    const ended = () => {
      if (!this.disposed && this.local.get(item.source)?.track === item.track)
        this.callbacks.sourceEnded(item.source);
    };
    item.track.addEventListener("ended", ended);
    this.local.set(item.source, { ...item, sender, ended });
  }
  /** Keep an acknowledged publication and its sender when the envelope permits it. */
  async replaceDevice(item: CapturedTrack, current: () => boolean) {
    this.replacements.add(item);
    try {
      return await this.producerQueue.run(async () => {
        this.check();
        if (!current() || (item.source === "microphone" && this.self()?.muted))
          throw new ReplacedGeneration();
        const previous = this.local.get(item.source);
        // A newer device choice may follow the preceding choice's unpublish.
        if (!previous) {
          await this.publishTracks([item], current);
          return;
        }
        const check = () => {
          this.check();
          if (
            !current() ||
            this.local.get(item.source) !== previous ||
            previous.track.readyState !== "live" ||
            (item.source === "microphone" && this.self()?.muted)
          )
            throw new ReplacedGeneration();
          if (item.track.readyState !== "live")
            throw new CaptureEnded(message("media.captureEnded"));
        };
        check();
        item.track.enabled = false;
        try {
          await previous.sender.replaceTrack(item.track);
        } catch (error) {
          check();
          if (
            error instanceof DOMException &&
            error.name === "InvalidModificationError"
          ) {
            stopCapture([previous]);
            await this.unpublishSources([item.source]);
            await this.publishTracks([item], current);
            return;
          }
          throw error;
        }
        check();
        previous.track.removeEventListener("ended", previous.ended);
        this.streams.get(previous.track)?.removeTrack(previous.track);
        this.streams.delete(previous.track);
        stopCapture([previous]);
        this.installLocalTrack(item, previous.sender);
        // Mute may have changed while replaceTrack was pending.
        item.track.enabled = item.source !== "microphone" || !this.muted;
        this.callbacks.changed();
      });
    } catch (error) {
      stopCapture([item]);
      throw error;
    } finally {
      this.replacements.delete(item);
    }
  }
  private removeLocalSource(source: MediaSource) {
    const item = this.local.get(source);
    if (!item) return;
    item.track.removeEventListener("ended", item.ended);
    stopCapture([item]);
    this.producer.removeTrack(item.sender);
    // Keep the inactive m-section: closing SFU flow does not renegotiate its
    // transport, and stopping the first transceiver would change the BUNDLE tag.
    this.local.delete(source);
  }
  stopSources(sources: MediaSource[]) {
    const expanded = sources.includes("screen_video")
      ? [...new Set([...sources, "screen_audio" as const])]
      : sources;
    // Stop capture immediately, even while an earlier negotiation is awaiting its answer.
    for (const item of this.replacements)
      if (expanded.includes(item.source)) stopCapture([item]);
    for (const source of expanded) {
      const item = this.local.get(source);
      if (item) {
        item.track.removeEventListener("ended", item.ended);
        stopCapture([item]);
      }
    }
    this.callbacks.changed();
    return this.producerQueue.run(() => this.unpublishSources(expanded));
  }
  private async unpublishSources(sources: MediaSource[]) {
    this.check();
    const present = sources.filter((source) => this.local.has(source));
    if (!present.length) return;
    const operationId = crypto.randomUUID();
    const result = expectMedia(
      await this.rpc("unpublish", {
        handle: this.handle,
        operationId,
        issuedAt: Date.now(),
        expectedSessionVersion: this.producerVersion,
        sources: present,
      }),
      "completed",
    );
    if (result.operationId !== operationId)
      throw new UiMessageError(message("media.responseChanged"));
    this.producerVersion = result.sessionVersion;
    for (const source of present) this.removeLocalSource(source);
    this.callbacks.changed();
  }
  updateSnapshot(snapshot: MediaSnapshot) {
    this.check();
    if (snapshot.revision < this.snapshot.revision) return;
    const old = this.self();
    const self = snapshot.participants.find(
      (participant) => participant.id === this.handle.participantId,
    );
    if (
      !self ||
      self.status !== "active" ||
      self.generation !== this.handle.accountGeneration
    )
      throw new RosterUnavailable();
    this.snapshot = snapshot;
    this.reconcile();
    this.setMuted(this.muted);
    if (self.muted && !old?.muted)
      void this.stopSources(["microphone", "screen_audio"]).catch(
        this.callbacks.failed,
      );
    if (self.screenRevoked && !old?.screenRevoked)
      void this.stopSources(["screen_video"]).catch(this.callbacks.failed);
  }
  selectScreen(id: string | null) {
    this.selectedScreen = id;
    this.reconcile();
  }
  showVideo(cameras: boolean, screen: boolean) {
    if (this.visible.cameras === cameras && this.visible.screen === screen)
      return;
    this.visible = { cameras, screen };
    this.reconcile();
  }
  setHiddenUsers(userIds: readonly string[]) {
    this.hiddenUserIds = new Set(userIds);
    this.reconcile();
  }
  reconcile() {
    this.check();
    this.desired = desiredPublications(
      this.snapshot,
      this.handle.participantId,
      this.selectedScreen,
      this.visible,
      this.hiddenUserIds,
    );
    this.syncPlayback();
    this.callbacks.changed();
    if (this.reconcileScheduled) return;
    this.reconcileScheduled = true;
    void this.consumerQueue
      .run(async () => {
        try {
          this.check();
          while (true) {
            this.check();
            // Server deafen already closes forwarding; /subscribe itself is forbidden until lifted.
            if (this.self()?.deafened) {
              this.subscribedIds = [];
              this.subscriptions.clear();
              this.syncPlayback();
              return;
            }
            const desired = this.desired.map((pub) => pub.id).sort();
            if (JSON.stringify(desired) === JSON.stringify(this.subscribedIds))
              return;
            const operationId = crypto.randomUUID();
            let result;
            try {
              result = await this.rpc("subscribe", {
                handle: this.handle,
                operationId,
                issuedAt: Date.now(),
                expectedSessionVersion: this.consumerVersion,
                publicationIds: desired,
              });
            } catch (error) {
              if (error instanceof MediaError) {
                if (error.outcome.kind === "publication_unavailable") return;
                if (error.outcome.kind === "action_restricted") {
                  this.desired = [];
                  this.subscribedIds = [];
                  this.subscriptions.clear();
                  this.syncPlayback();
                  this.callbacks.changed();
                }
              }
              throw error;
            }
            if (result.kind === "negotiation") {
              if (
                result.operationId !== operationId ||
                result.phase !== "awaiting_answer" ||
                result.sessionDescription.type !== "offer"
              )
                throw new UiMessageError(message("media.offerChanged"));
              this.subscriptions = new Map(
                result.subscriptions.map((sub) => [sub.mid, sub.publication]),
              );
              this.syncPlayback();
              await this.consumer.setRemoteDescription(
                result.sessionDescription,
              );
              this.check();
              const answer = await this.consumer.createAnswer();
              this.check();
              await this.consumer.setLocalDescription(answer);
              const description = await gatheredLocalDescription(
                this.consumer,
                this.abort.signal,
                result.deadline,
              );
              this.check();
              result = await this.rpc("answer", {
                handle: this.handle,
                operationId,
                expectedSessionVersion: result.sessionVersion,
                sessionDescription: {
                  type: "answer",
                  sdp: description.sdp,
                },
              });
            }
            const completed = expectMedia(result, "completed");
            if (
              completed.operationId !== operationId ||
              completed.subscriptions === undefined
            )
              throw new UiMessageError(message("media.responseChanged"));
            this.consumerVersion = completed.sessionVersion;
            this.subscriptions = new Map(
              completed.subscriptions.map((sub) => [sub.mid, sub.publication]),
            );
            this.subscribedIds = desired;
            this.subscriptions = new Map(
              [...this.subscriptions].filter(([, pub]) =>
                desired.includes(pub.id),
              ),
            );
            this.syncPlayback();
            this.callbacks.changed();
          }
        } finally {
          this.reconcileScheduled = false;
        }
      })
      .catch(this.callbacks.failed);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    for (const remove of this.listeners) remove();
    for (const item of this.local.values()) {
      item.track.removeEventListener("ended", item.ended);
      stopCapture([item]);
    }
    stopCapture([...this.replacements]);
    this.replacements.clear();
    for (const track of this.received.values()) track.stop();
    this.local.clear();
    this.received.clear();
    this.subscriptions.clear();
    this.producer.close();
    this.consumer.close();
  }
}
