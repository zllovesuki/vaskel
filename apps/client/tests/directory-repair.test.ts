import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryRepair } from "@/client/features/workspace/directory-repair";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("directory safety discovery", () => {
  it("eventually discovers a missed new membership beyond loaded pages while a selected owner remains mounted", async () => {
    // The first page already contains the selected owner. The joined owner is
    // beyond two more pages and its account hint was lost.
    const pages = [["selected"], ["older-owner"], ["new-membership"]];
    const loaded = [pages[0]!];
    const refresh = vi.fn(async () => ({
      hasNextPage: loaded.length < pages.length,
    }));
    const next = vi.fn(async () => {
      loaded.push(pages[loaded.length]!);
    });
    const repair = new DirectoryRepair({
      interval: 60_000,
      visible: () => true,
      refresh,
      next,
    });
    try {
      // Ordinary successful directory hints do not reset the owned deadline.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        await refresh();
      }
      expect(next).toHaveBeenCalledTimes(1);
      expect(loaded.flat()).not.toContain("new-membership");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(next).toHaveBeenCalledTimes(2);
      expect(loaded.flat()).toContain("new-membership");
      expect(loaded[0]).toContain("selected");
    } finally {
      repair.dispose();
    }
  });

  it("preserves discovery progress through repeated optional connection flaps", async () => {
    const refresh = vi.fn(async () => ({ hasNextPage: true }));
    const next = vi.fn(async () => {});
    const repair = new DirectoryRepair({
      interval: 60_000,
      visible: () => true,
      refresh,
      next,
    });
    try {
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        repair.setInterval(i % 2 === 0 ? 30_000 : 60_000);
      }
      expect(next.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(refresh.mock.calls.length).toBe(next.mock.calls.length);
    } finally {
      repair.dispose();
    }
  });

  it("defers hidden repair, resumes immediately and fences continuation after disposal", async () => {
    let visible = false;
    let resolve!: (value: { hasNextPage: boolean }) => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ hasNextPage: boolean }>((done) => {
          resolve = done;
        }),
    );
    const next = vi.fn(async () => {});
    const repair = new DirectoryRepair({
      interval: 30_000,
      visible: () => visible,
      refresh,
      next,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
    visible = true;
    const foreground = repair.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    repair.dispose();
    resolve({ hasNextPage: true });
    await foreground;
    expect(next).not.toHaveBeenCalled();
  });
});
