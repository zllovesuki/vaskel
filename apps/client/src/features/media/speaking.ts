import { rootMeanSquare, SpeakingGate } from "./presentation";

let shared: AudioContext | null = null;
function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  shared ??= new AudioContext();
  if (shared.state === "suspended") void shared.resume().catch(() => {});
  return shared;
}

/**
 * Reports whether a stream carries speech, from a local analyser over the
 * received audio. The SFU exposes no active-speaker signal, so this is the
 * only source of speaking rings, and it never leaves the browser.
 */
export class SpeakingMonitor {
  private readonly source: MediaStreamAudioSourceNode | null;
  private readonly analyser: AnalyserNode | null;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly gate = new SpeakingGate();
  private readonly listeners = new Set<() => void>();
  private speaking = false;
  private frame: number | undefined;
  private lastSample = 0;
  constructor(stream: MediaStream) {
    const context = audioContext();
    if (!context || stream.getAudioTracks().length === 0) {
      this.source = null;
      this.analyser = null;
      this.samples = new Float32Array(0);
      return;
    }
    this.source = context.createMediaStreamSource(stream);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.source.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.frame = requestAnimationFrame(this.tick);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.speaking;
  private tick = () => {
    this.frame = requestAnimationFrame(this.tick);
    const now = performance.now();
    // Ten samples a second are plenty for a ring; the analyser is cheap, React is not.
    if (now - this.lastSample < 100 || !this.analyser) return;
    this.lastSample = now;
    this.analyser.getFloatTimeDomainData(this.samples);
    const speaking = this.gate.update(rootMeanSquare(this.samples), now);
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    for (const listener of this.listeners) listener();
  };
  dispose() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.listeners.clear();
  }
}
