import type { CapturedTrack } from "./capture";

/** An owned zero-sample source, with no microphone or speaker connection. */
export class SilentAudio implements CapturedTrack {
  readonly source = "microphone";
  readonly synthetic = true;
  readonly track: MediaStreamTrack;
  private readonly context = new AudioContext();
  private readonly destination = this.context.createMediaStreamDestination();
  private readonly buffer = this.context.createBufferSource();
  private disposed = false;

  constructor() {
    this.buffer.buffer = this.context.createBuffer(
      1,
      128,
      this.context.sampleRate,
    );
    this.buffer.loop = true;
    this.buffer.connect(this.destination);
    this.buffer.start();
    this.track = this.destination.stream.getAudioTracks()[0]!;
  }

  /** Invoke synchronously in the activation handler; blocked browsers never stall startup. */
  resume(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.context.state === "running") return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve(!this.disposed && this.context.state === "running");
      };
      const timer = setTimeout(finish, 1_000);
      void this.context.resume().then(finish, finish);
    });
  }

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.track.stop();
    this.buffer.stop();
    this.buffer.disconnect();
    this.destination.disconnect();
    void this.context.close().catch(() => {});
  };
}
