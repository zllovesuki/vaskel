import { barrier } from "@tests/helpers/barrier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedWork } from "@/server/actors/shared/bounded-work";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded work admission", () => {
  it("keeps timer creation linear as overlapping maps wait for the same slots", async () => {
    const pool = new BoundedWork(2);
    const blocked = barrier();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const entries = Array.from({ length: 48 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const results = entries.map((entry) =>
      pool.map([entry], async (value) => {
        active++;
        peak = Math.max(peak, active);
        await blocked.promise;
        active--;
        return value;
      }),
    );
    await Promise.resolve();
    expect(active).toBe(2);
    blocked.release();
    expect(await Promise.all(results)).toEqual(
      entries.map((value) => [{ ok: true, value }]),
    );
    expect(peak).toBe(2);
    // Waiting must not repeatedly create timers as unrelated operations finish.
    expect(timers.mock.calls.length).toBeLessThanOrEqual(entries.length * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes an expired waiter while occupied slots stay reserved", async () => {
    const pool = new BoundedWork(1);
    const blocked = barrier();
    const first = pool.run(() => blocked.promise, Date.now() + 1_000);
    const expiredOperation = vi.fn(async () => "expired");
    const expired = pool.map([0], expiredOperation, Date.now() + 10);
    const nextOperation = vi.fn(async () => "next");
    const next = pool.map([0], nextOperation, Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(await expired).toEqual([{ ok: false }]);
    expect(expiredOperation).not.toHaveBeenCalled();
    expect(nextOperation).not.toHaveBeenCalled();
    blocked.release();
    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await next).toEqual([{ ok: true, value: "next" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues past an expired head when settlement precedes its timer callback", async () => {
    const pool = new BoundedWork(1);
    const blocked = barrier();
    const now = Date.now();
    const first = pool.run(() => blocked.promise, now + 1_000);
    const expiredOperation = vi.fn(async () => "expired");
    const expired = pool.map([0], expiredOperation, now + 10);
    const next = pool.map([0], async () => "next", now + 1_000);
    vi.setSystemTime(now + 11);
    blocked.release();
    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await expired).toEqual([{ ok: false }]);
    expect(expiredOperation).not.toHaveBeenCalled();
    expect(await next).toEqual([{ ok: true, value: "next" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fills both released slots even when a queued key becomes a duplicate", async () => {
    const pool = new BoundedWork(2);
    const initial = barrier();
    const admitted = barrier();
    const deadline = Date.now() + 1_000;
    const first = pool.map(["a", "b"], () => initial.promise, deadline);
    const starts: string[] = [];
    const operation = async (key: string) => {
      starts.push(key);
      await admitted.promise;
      return key;
    };
    const next = pool.map(["shared"], operation, deadline, String);
    const duplicate = pool.map(["shared"], operation, deadline, String);
    const other = pool.map(["other"], operation, deadline, String);
    initial.release();
    await first;
    expect(await duplicate).toEqual([{ ok: false }]);
    expect(starts).toEqual(["shared", "other"]);
    expect(await pool.run(async () => "extra", deadline)).toEqual({
      ok: false,
    });
    admitted.release();
    expect(await next).toEqual([{ ok: true, value: "shared" }]);
    expect(await other).toEqual([{ ok: true, value: "other" }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
