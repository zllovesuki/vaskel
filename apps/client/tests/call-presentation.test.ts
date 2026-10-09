import { describe, expect, it } from "vitest";
import {
  formatDuration,
  rootMeanSquare,
  SpeakingGate,
} from "@/client/features/media/presentation";

describe("call presentation helpers", () => {
  it("formats a call duration in minutes until an hour has passed", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(59_999)).toBe("00:59");
    expect(formatDuration(27 * 60_000 + 14_000)).toBe("27:14");
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(-5_000)).toBe("00:00");
  });
  it("holds a speaking flag through short gaps and drops it after silence", () => {
    const gate = new SpeakingGate(0.02, 300);
    expect(gate.update(0.001, 0)).toBe(false);
    expect(gate.update(0.05, 100)).toBe(true);
    // A syllable gap shorter than the hold keeps the ring up.
    expect(gate.update(0.0, 250)).toBe(true);
    expect(gate.update(0.0, 400)).toBe(true);
    expect(gate.update(0.0, 401)).toBe(false);
    expect(gate.update(0.02, 500)).toBe(true);
  });
  it("measures level as the root mean square of a sample window", () => {
    expect(rootMeanSquare([])).toBe(0);
    expect(rootMeanSquare([0, 0, 0])).toBe(0);
    expect(rootMeanSquare([0.5, -0.5])).toBeCloseTo(0.5);
    expect(rootMeanSquare(new Float32Array([1, 1, 1, 1]))).toBe(1);
  });
});
