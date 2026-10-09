import { apiFailure } from "@/client/api/errors";
import type {
  MediaRoomRef,
  MediaSnapshot,
  ModerateMediaRequest,
  PendingMediaCommand,
} from "@vaskel/contracts/media";
import { type CapturedTrack } from "@/client/features/media/capture";
import { type DeviceKind } from "@/client/features/media/devices";
import { type CallIntent } from "@/client/features/media/intent";
import { type CallState, type LifecycleTransition } from "./state";
import { api } from "@/client/api/contract";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import {
  mediaErrorMessage,
  actionFailure,
  expectMedia,
  MediaError,
  ReplacedGeneration,
  sameRoom,
  terminalMediaFailure,
} from "@/client/features/media/protocol";
import { isNetworkError } from "@/client/api/client";

import type { MediaSource } from "@vaskel/contracts/media";
import {
  CaptureEnded,
  captureDevice,
  captureError,
  captureScreen,
  stopCapture,
} from "@/client/features/media/capture";
import {
  readDeviceChoices,
  writeDeviceChoices,
} from "@/client/features/media/devices";
import {
  IntentStore,
  readPictureInPicture,
  writePictureInPicture,
  privateStorage,
  deviceToken,
} from "@/client/features/media/intent";
import { MediaSession } from "@/client/features/media/session";
import { SilentAudio } from "@/client/features/media/silent-audio";
import { AudioOutput } from "./audio-output";
import { createMediaTransport } from "./transport";
import {
  initialCallState,
  joiningCallState,
  leftCallState,
  failedCallState,
} from "./state";

export class MediaController {
  private state: CallState;
  private subscribers = new Set<() => void>();
  private intent: CallIntent | null;
  private store: IntentStore;
  private session: MediaSession | null = null;
  private silence: SilentAudio | null = null;
  private lifecycle = 0;
  private controlAbort = new AbortController();
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private mounted = 0;
  private joinFlight: number | null = null;
  private started = false;
  private initialized = false;
  private resumeAfterAccess = false;
  private disposed = false;
  private captures = new Map<MediaSource, symbol>();
  private readonly audio = new AudioOutput();
  private refreshing = new WeakMap<MediaSession, Promise<void>>();
  private refreshAgain = new WeakSet<MediaSession>();
  constructor(
    userId: string,
    origin: string,
    private canUseNetwork = true,
  ) {
    this.transport = createMediaTransport(userId, () => this.canUseNetwork);

    this.store = new IntentStore(origin, userId, privateStorage());
    this.intent = this.store.read();
    this.state = initialCallState(
      this.intent,
      this.store.muted(),
      readPictureInPicture(),
    );
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  };
  private patch(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.subscribers) listener();
  }
  attach() {
    this.mounted++;
    if (!this.started) {
      this.started = true;
      if (this.canUseNetwork) void this.start();
    }
    return () => {
      this.mounted--;
      // React StrictMode rehearses cleanup/setup synchronously. A real unmount closes this account.
      queueMicrotask(() => {
        if (!this.mounted && !this.disposed) this.dispose();
      });
    };
  }
  setNetworkAllowed(allowed: boolean) {
    if (this.disposed || allowed === this.canUseNetwork) return;
    this.canUseNetwork = allowed;
    if (!allowed) {
      this.resumeAfterAccess = Boolean(this.intent);
      // An interrupted SDP/ack exchange cannot safely continue on the old peers.
      // Keep the existing intent and controller, using normal recovery ownership.
      if (this.intent || this.state.phase === "joining")
        this.transition(this.lifecycle, {
          kind: "failed",
          error: new UiMessageError(message("media.accessPaused")),
        });
      else this.cancelLocal();
      return;
    }
    const resume = this.resumeAfterAccess;
    this.resumeAfterAccess = false;
    if (this.started && !this.initialized) void this.start();
    else if (resume && this.intent) void this.resume();
  }
  private persist(intent: CallIntent | null) {
    this.intent = intent;
    this.store.write(intent);
  }
  private async start() {
    const epoch = this.lifecycle;
    try {
      const config = await api.mediaConfig(undefined, {
        signal: this.controlAbort.signal,
      });
      if (this.disposed || epoch !== this.lifecycle || !this.canUseNetwork)
        return;
      this.patch({ configured: config.configured });
      this.initialized = true;
      if (config.configured && this.intent) {
        const navigation = performance.getEntriesByType("navigation")[0] as
          PerformanceNavigationTiming | undefined;
        // A duplicated tab can inherit sessionStorage. Only a document reload/history
        // restoration may automatically reuse the saved endpoint capability.
        if (navigation?.type === "navigate") this.persist(null);
        else await this.resume();
      }
    } catch (error) {
      this.transition(epoch, {
        kind: "action_failed",
        message: mediaErrorMessage(error),
      });
    }
  }
  /** Replay the exact request on an ambiguous transport failure; never allocate a new operation ID. */
  private readonly transport: ReturnType<typeof createMediaTransport>;
  private current(epoch: number) {
    if (epoch !== this.lifecycle || this.disposed)
      throw new ReplacedGeneration();
  }
  private changed = () => {
    const session = this.session;
    if (!session) return;
    this.patch({ session: session.view() });
  };
  private cancelLocal() {
    this.lifecycle++;
    this.controlAbort.abort();
    this.controlAbort = new AbortController();
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    this.captures.clear();
    this.session?.dispose();
    this.session = null;
    this.silence?.dispose();
    this.silence = null;
    this.audio.clear();
  }
  /** Only this path decides participation, recovery and the displayed call phase. */
  private transition(epoch: number, event: LifecycleTransition) {
    if (epoch !== this.lifecycle || this.disposed) return;
    switch (event.kind) {
      case "joining":
        this.persist(event.intent);
        this.patch(joiningCallState(event.intent));
        return;
      case "ready": {
        const session = this.session;
        if (!session) return;
        try {
          if (event.snapshot) session.updateSnapshot(event.snapshot);
          const self = session.snapshot.participants.find(
            (participant) => participant.id === session.handle.participantId,
          );
          if (self?.muted) {
            this.silence?.dispose();
            this.silence = null;
          }
          if (self?.muted && !this.state.muted) {
            this.store.setMuted(true);
            session.setMuted(true);
          }
          this.patch({
            phase: session.reconnecting ? "reconnecting" : "active",
            session: session.view(),
            muted: this.state.muted || Boolean(self?.muted),
            joinedAt: this.state.joinedAt ?? Date.now(),
            error: session.reconnecting
              ? message("media.reconnectingNotice")
              : this.state.error?.key === "media.reconnectingNotice"
                ? null
                : this.state.error,
          });
          this.applyOutput();
        } catch (error) {
          this.transition(epoch, { kind: "failed", error });
        }
        return;
      }
      case "action_failed":
        this.patch({ error: event.message });
        return;
      case "transfer":
        this.patch({
          phase: this.session
            ? this.session.reconnecting
              ? "reconnecting"
              : "active"
            : this.intent
              ? "error"
              : "idle",
          room: this.intent?.room ?? null,
          label: this.intent?.label ?? "",
          transfer: event.target,
          error: null,
        });
        return;
      case "left":
        this.resumeAfterAccess = false;
        // Clear rejoin authority before network work, including logout and late joins.
        this.persist(null);
        this.cancelLocal();
        this.patch(leftCallState());
        return;
      case "failed": {
        const error = event.error;
        if (error instanceof ReplacedGeneration) return;
        if (actionFailure(error) && this.session) {
          this.patch({ error: mediaErrorMessage(error) });
          return;
        }
        if (terminalMediaFailure(error)) {
          this.resumeAfterAccess = false;
          this.persist(null);
        } else if (
          error instanceof MediaError &&
          error.outcome.kind === "recovery_required" &&
          this.intent
        )
          this.persist({
            ...this.intent,
            handle: error.outcome.handle,
            pending: null,
          });
        this.cancelLocal();
        this.patch(failedCallState(this.intent, error));
      }
    }
  }
  async join(room: MediaRoomRef, label: string, canModerate = false) {
    if (
      this.disposed ||
      !this.canUseNetwork ||
      this.joinFlight === this.lifecycle ||
      this.state.phase === "joining" ||
      sameRoom(this.session?.handle.room, room)
    )
      return;
    const epoch = this.lifecycle;
    this.joinFlight = epoch;
    const silence = this.prepareSilence();
    const signal = this.controlAbort.signal;
    const stopPrepared = () => silence?.dispose();
    signal.addEventListener("abort", stopPrepared, { once: true });
    try {
      const status = expectMedia(
        await this.transport("status", undefined, this.controlAbort.signal),
        "media_status",
      );
      this.current(epoch);
      switch (status.admission.kind) {
        case "transfer_required":
          this.transition(epoch, {
            kind: "transfer",
            target: { room, label, canModerate, generation: status.generation },
          });
          return;
        case "cleanup_pending":
          throw new MediaError({
            kind: "cleanup_pending",
            generation: status.generation,
          });
        case "available":
        case "resumable":
          break;
      }
      signal.removeEventListener("abort", stopPrepared);
      await this.begin(
        {
          room,
          label,
          canModerate,
          handle: null,
          pending: {
            path: "join",
            body: {
              room,
              clientId: crypto.randomUUID(),
              deviceToken: deviceToken(),
              commandId: crypto.randomUUID(),
              issuedAt: Date.now(),
              expectedGeneration: status.generation,
            },
          },
        },
        silence,
      );
    } catch (error) {
      this.transition(epoch, { kind: "failed", error });
    } finally {
      signal.removeEventListener("abort", stopPrepared);
      if (this.silence !== silence) silence?.dispose();
      if (this.joinFlight === epoch) this.joinFlight = null;
    }
  }
  cancelTransfer = () => this.patch({ transfer: null });
  moveCall = async () => {
    const target = this.state.transfer;
    if (!target || !this.canUseNetwork) return;
    this.resumeAfterAccess = false;
    await this.begin({
      room: target.room,
      label: target.label,
      canModerate: target.canModerate,
      handle: null,
      pending: {
        path: "transfer",
        body: {
          room: target.room,
          clientId: crypto.randomUUID(),
          deviceToken: deviceToken(),
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expectedGeneration: target.generation,
        },
      },
    });
  };
  private prepareSilence() {
    if (!this.state.muted) return null;
    try {
      const source = new SilentAudio();
      void source.resume();
      return source;
    } catch {
      return null;
    }
  }
  private async begin(intent: CallIntent, silence = this.prepareSilence()) {
    if (this.disposed || !this.canUseNetwork) {
      silence?.dispose();
      return;
    }
    this.cancelLocal();
    this.silence = silence;
    const epoch = this.lifecycle;
    this.transition(epoch, { kind: "joining", intent });
    const pending = intent.pending;
    if (!pending) return;
    try {
      if (typeof RTCPeerConnection === "undefined")
        throw new UiMessageError(message("media.browserUnsupported"));
      const result = await this.transport(
        pending.path,
        pending.body,
        this.controlAbort.signal,
      );
      this.current(epoch);
      const joined = expectMedia(result, "joined");
      this.persist({ ...intent, handle: joined.handle, pending: null });
      const session = new MediaSession(
        joined.handle,
        joined.producerVersion,
        joined.consumerVersion,
        joined.snapshot,
        this.transport,
        {
          changed: () => {
            if (this.session === session) this.changed();
          },
          failed: (error) => {
            this.transition(epoch, { kind: "failed", error });
          },
          sourceEnded: (source) => {
            if (this.session === session) {
              if (source === "microphone") {
                this.store.setMuted(true);
                this.patch({ muted: true });
                session.setMuted(true);
              }
              void this.stopSource(source);
            }
          },
          connection: () => {
            this.transition(epoch, { kind: "ready" });
          },
        },
      );
      this.session = session;
      session.setHiddenUsers(this.state.hiddenUserIds);
      session.setMuted(this.state.muted);
      this.transition(epoch, { kind: "ready", snapshot: joined.snapshot });
      if (this.session !== session) return;
      this.heartbeat = setTimeout(() => void this.refresh(session), 10_000);
      if (!this.state.muted) void this.startDevice("microphone");
      else void this.startSilence(session);
    } catch (error) {
      if (
        error instanceof MediaError &&
        error.outcome.kind === "transfer_required"
      ) {
        this.current(epoch);
        this.silence?.dispose();
        this.silence = null;
        this.persist(null);
        this.transition(epoch, {
          kind: "transfer",
          target: {
            room: intent.room,
            label: intent.label,
            canModerate: intent.canModerate,
            generation: error.outcome.currentGeneration,
          },
        });
        return;
      }
      this.transition(epoch, { kind: "failed", error });
    }
  }
  resume = async () => {
    const intent = this.intent;
    if (!this.canUseNetwork || !intent || this.state.phase === "joining")
      return;
    const pending: PendingMediaCommand | null =
      intent.pending ??
      (intent.handle
        ? {
            path: "resume",
            body: {
              handle: intent.handle,
              commandId: crypto.randomUUID(),
              issuedAt: Date.now(),
              nextDeviceToken: deviceToken(),
            },
          }
        : null);
    if (pending) await this.begin({ ...intent, pending });
  };
  async leave() {
    const pending = this.intent?.pending;
    const handle = this.session?.handle ?? this.intent?.handle;
    const target = pending ? { pending } : handle ? { handle } : null;
    this.transition(this.lifecycle, { kind: "left" });
    if (!target) return;
    const epoch = this.lifecycle;
    try {
      const result = await this.transport(
        "leave",
        { ...target, commandId: crypto.randomUUID(), issuedAt: Date.now() },
        AbortSignal.timeout(15_000),
      );
      expectMedia(result, "left");
    } catch (error) {
      if (
        error instanceof MediaError &&
        ["participation_ended", "stale_generation", "unauthenticated"].includes(
          error.outcome.kind,
        )
      )
        return;
      if (
        !(error instanceof ReplacedGeneration) &&
        this.lifecycle === epoch &&
        !this.disposed
      )
        this.patch({
          error: message("media.leaveUnconfirmed"),
        });
    }
  }
  /** Account-event hints and reconnects share the heartbeat's owned roster read. */
  refreshRoom = async (room?: MediaRoomRef) => {
    const session = this.session;
    if (session && (!room || sameRoom(session.handle.room, room)))
      await this.refresh(session);
  };
  private refresh(session: MediaSession): Promise<void> {
    this.refreshAgain.add(session);
    const current = this.refreshing.get(session);
    if (current) return current;
    const flight = this.refreshLoop(session).finally(() => {
      this.refreshing.delete(session);
    });
    this.refreshing.set(session, flight);
    return flight;
  }
  private async refreshLoop(session: MediaSession) {
    do {
      this.refreshAgain.delete(session);
      await this.refreshOnce(session);
    } while (this.session === session && this.refreshAgain.has(session));
  }
  private async refreshOnce(session: MediaSession) {
    if (!this.canUseNetwork || this.session !== session) return;
    const epoch = this.lifecycle;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    try {
      const result = expectMedia(
        await session.rpc("heartbeat", { handle: session.handle }),
        "heartbeat",
      );
      this.transition(epoch, { kind: "ready", snapshot: result.snapshot });
    } catch (error) {
      if (this.session !== session) return;
      if (
        isNetworkError(error) ||
        (apiFailure(error) &&
          apiFailure(error)?.failure === "http" &&
          (apiFailure(error)?.status ?? 0) >= 500)
      ) {
        // Notification/control transport failure is not evidence of departure.
        // The durable participant lease and the next owned read settle that.
        this.patch({
          phase: "reconnecting",
          error: message("media.reconnectingNotice"),
        });
      } else this.transition(epoch, { kind: "failed", error });
    }
    if (this.session === session)
      this.heartbeat = setTimeout(() => void this.refresh(session), 10_000);
  }
  private async finishCapture(
    session: MediaSession,
    source: MediaSource,
    token: symbol,
    capture: Promise<CapturedTrack[]>,
    replacing = false,
  ) {
    const epoch = this.lifecycle;
    try {
      const tracks = await capture;
      if (this.session !== session || this.captures.get(source) !== token) {
        stopCapture(tracks);
        return;
      }
      try {
        const current = () =>
          this.session === session && this.captures.get(source) === token;
        if (replacing && tracks[0])
          await session.replaceDevice(tracks[0], current);
        else await session.publish(tracks, current);
        if (source === "microphone" && session.hasDevice(source)) {
          this.silence?.dispose();
          this.silence = null;
        }
      } catch (error) {
        if (this.session === session) {
          if (
            replacing &&
            source === "microphone" &&
            session.hasSource(source) &&
            !session.hasDevice(source) &&
            !(error instanceof MediaError) &&
            !(error instanceof ReplacedGeneration)
          ) {
            this.store.setMuted(true);
            session.setMuted(true);
            this.patch({ muted: true, error: captureError(error, source) });
          } else if (error instanceof CaptureEnded)
            this.transition(epoch, {
              kind: "action_failed",
              message: error.uiMessage,
            });
          else this.transition(epoch, { kind: "failed", error });
        }
      }
    } catch (error) {
      if (this.session === session && this.captures.get(source) === token) {
        if (source === "microphone" && !session.hasDevice(source)) {
          this.store.setMuted(true);
          session.setMuted(true);
          this.patch({ muted: true });
        }
        this.transition(epoch, {
          kind: "action_failed",
          message: captureError(error, source),
        });
        if (source === "microphone" && !session.hasSource(source))
          void this.startSilence(session);
      }
    } finally {
      if (this.silence?.track.readyState === "ended") this.silence = null;
      if (this.captures.get(source) === token) {
        this.captures.delete(source);
        this.patch({ pendingSources: [...this.captures.keys()] });
      }
    }
  }
  private async startSilence(session: MediaSession) {
    if (this.session !== session || session.hasSource("microphone")) return;
    const self = session.snapshot.participants.find(
      (participant) => participant.id === session.handle.participantId,
    );
    if (self?.muted) {
      this.silence?.dispose();
      this.silence = null;
      return;
    }
    const source = this.silence ?? this.prepareSilence();
    if (!source) {
      this.patch({
        error: this.state.error ?? message("media.microphoneFailed"),
      });
      return;
    }
    this.silence = source;
    const running = await source.resume();
    if (this.session !== session || this.silence !== source) return;
    if (!running) {
      this.patch({ playbackBlocked: true });
      return;
    }
    if (session.hasSource("microphone") || this.captures.has("microphone"))
      return;
    const token = Symbol("microphone");
    this.captures.set("microphone", token);
    this.patch({ pendingSources: [...this.captures.keys()] });
    await this.finishCapture(
      session,
      "microphone",
      token,
      Promise.resolve([source]),
    );
    if (this.session === session && !this.state.muted)
      void this.startDevice("microphone");
  }
  startDevice(source: "microphone" | "camera") {
    const session = this.session;
    if (
      !this.canUseNetwork ||
      !session ||
      this.captures.has(source) ||
      session.hasDevice(source)
    )
      return;
    const token = Symbol(source);
    this.captures.set(source, token);
    this.patch({ pendingSources: [...this.captures.keys()], error: null });
    return this.finishCapture(
      session,
      source,
      token,
      captureDevice(source, readDeviceChoices()[source]),
      session.hasSource(source),
    );
  }
  /** Remembers a device and replaces a live source without renegotiating when possible. */
  async switchDevice(kind: DeviceKind, deviceId: string | null) {
    const choices = readDeviceChoices();
    if (deviceId) choices[kind] = deviceId;
    else delete choices[kind];
    writeDeviceChoices(choices);
    if (kind === "speaker") {
      this.applyOutput();
      return;
    }
    const session = this.session;
    if (!this.canUseNetwork || !session || !session.hasDevice(kind)) return;
    const token = Symbol(kind);
    this.captures.set(kind, token);
    this.patch({ pendingSources: [...this.captures.keys()], error: null });
    await this.finishCapture(
      session,
      kind,
      token,
      captureDevice(kind, deviceId ?? undefined),
      true,
    );
  }
  /** Client-side deafening only: what this tab hears, never what it sends. */
  setDeafened = (deafened: boolean) => {
    if (this.intent) this.persist({ ...this.intent, deafened });
    this.patch({ deafened });
    this.applyOutput();
  };
  setPictureInPicture = (enabled: boolean) => {
    writePictureInPicture(enabled);
    this.patch({ pictureInPicture: enabled });
  };
  private applyOutput() {
    this.audio.apply(this.state.deafened);
  }
  shareScreen = () => {
    const session = this.session;
    if (
      !this.canUseNetwork ||
      !session ||
      this.captures.has("screen_video") ||
      session.hasSource("screen_video")
    )
      return;
    const token = Symbol("screen_video");
    this.captures.set("screen_video", token);
    // Invoke browser capture synchronously while the click still has transient activation.
    const capture = captureScreen();
    this.patch({ pendingSources: [...this.captures.keys()], error: null });
    void this.finishCapture(session, "screen_video", token, capture);
  };
  toggleMute = () => {
    if (!this.canUseNetwork && this.state.muted) return;
    const muted = !this.state.muted;
    this.store.setMuted(muted);
    this.patch({ muted, error: null });
    this.session?.setMuted(muted);
    if (!muted) void this.startDevice("microphone");
  };
  async stopSource(source: MediaSource) {
    if (source === "microphone") {
      this.silence?.dispose();
      this.silence = null;
    }
    this.captures.delete(source);
    if (source === "screen_video") this.captures.delete("screen_audio");
    this.patch({ pendingSources: [...this.captures.keys()] });
    const session = this.session;
    if (!session) return;
    const epoch = this.lifecycle;
    try {
      await session.stopSources([source]);
    } catch (error) {
      this.transition(epoch, { kind: "failed", error });
    }
  }
  setMediaHidden = (userId: string, hidden: boolean) => {
    if (!this.canUseNetwork || !this.session) return;
    const users = new Set(this.state.hiddenUserIds);
    if (hidden) users.add(userId);
    else users.delete(userId);
    const hiddenUserIds = [...users];
    if (this.intent) this.persist({ ...this.intent, hiddenUserIds });
    this.patch({ hiddenUserIds });
    this.session.setHiddenUsers(hiddenUserIds);
  };
  selectScreen = (id: string | null) => {
    if (this.canUseNetwork) this.session?.selectScreen(id);
  };
  showVideo = (cameras: boolean, screen: boolean) => {
    if (this.canUseNetwork) this.session?.showVideo(cameras, screen);
  };
  async moderate(
    participant: Pick<
      MediaSnapshot["participants"][number],
      "userId" | "generation" | "controlVersion"
    >,
    action: ModerateMediaRequest["action"],
    enabled: boolean,
  ) {
    const session = this.session;
    if (!this.canUseNetwork || !session || !this.state.canModerate) return;
    try {
      expectMedia(
        await session.rpc("moderate", {
          room: session.handle.room,
          userId: participant.userId,
          action,
          enabled,
          commandId: crypto.randomUUID(),
          participantGeneration: participant.generation,
          expectedControlVersion: participant.controlVersion,
        }),
        "moderated",
      );
      await this.refresh(session);
    } catch (error) {
      if (
        this.session === session &&
        error instanceof MediaError &&
        error.outcome.kind === "moderation_changed"
      )
        await this.refresh(session);
      if (this.session === session)
        this.patch({
          error: mediaErrorMessage(error),
        });
    }
  }
  registerAudio = (element: HTMLMediaElement) =>
    this.audio.register(element, this.state.deafened);
  playbackFailed = () => this.patch({ playbackBlocked: true });
  enableAudio = () => {
    const epoch = this.lifecycle;
    const session = this.session;
    const resume =
      this.silence && !session?.hasDevice("microphone")
        ? this.silence.resume()
        : Promise.resolve(true);
    void Promise.all([this.audio.play(), resume]).then(([results, running]) => {
      if (!this.disposed && epoch === this.lifecycle)
        this.patch({
          playbackBlocked:
            !running || results.some((result) => result.status === "rejected"),
        });
      if (running && session && this.session === session)
        void this.startSilence(session);
    });
  };
  dismissError = () => this.patch({ error: null });
  dispose() {
    if (this.disposed) return;
    void this.leave();
    this.disposed = true;
    this.cancelLocal();
    this.subscribers.clear();
  }
}
