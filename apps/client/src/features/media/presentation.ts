/** Elapsed call time as m:ss, or h:mm:ss once an hour has passed. */
export function formatDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** Root mean square of a time-domain sample window. */
export function rootMeanSquare(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Turns a level series into a stable speaking flag: the flag rises when the
 * level crosses the threshold and stays up for the hold time after the last
 * loud sample, so a syllable gap does not flicker the ring.
 */
export class SpeakingGate {
  private loudUntil = -Infinity;
  constructor(
    private readonly threshold = 0.02,
    private readonly holdMs = 300,
  ) {}
  update(level: number, now: number): boolean {
    if (level >= this.threshold) this.loudUntil = now + this.holdMs;
    return now <= this.loudUntil;
  }
}
