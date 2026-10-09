import { expect, it, vi } from "vitest";
import { deferred } from "@tests/shared/deferred";
import { holdWebLock } from "@/client/browser/locks";

const lock: Lock = { name: "resource", mode: "exclusive" };

/** Controls acquisition timing while the callback still determines release. */
function manager(grant: Promise<Lock | null>) {
  const finished = deferred();
  const returned = vi.fn(() => finished.resolve());
  const locks = {
    async request<T>(
      _name: string,
      options: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<Awaited<T>> {
      const run = typeof options === "function" ? options : callback;
      if (!run) throw new Error("Expected lock callback");
      const result = await run(await grant);
      returned();
      return result;
    },
  };
  return { locks, returned, finished: finished.promise };
}

it("holds an acquired lock until its owner releases it", async () => {
  const { locks, returned, finished } = manager(Promise.resolve(lock));
  const held = holdWebLock(locks, "draft");
  await expect(held.acquired).resolves.toBe(true);
  expect(returned).not.toHaveBeenCalled();

  held.release();
  held.release();
  await finished;
  expect(returned).toHaveBeenCalledOnce();
});

it("reports a busy lock without taking ownership", async () => {
  const { locks, finished } = manager(Promise.resolve(null));
  const held = holdWebLock(locks, "draft", { ifAvailable: true });
  await expect(held.acquired).resolves.toBe(false);
  held.release();
  await finished;
});

it("does not hold a queued lock after its owner has disposed", async () => {
  const grant = deferred<Lock>();
  const { locks, finished } = manager(grant.promise);
  const held = holdWebLock(locks, "viewing");
  held.release();
  grant.resolve(lock);

  await expect(held.acquired).resolves.toBe(false);
  await finished;
});

it("leaves acquisition errors to the caller", async () => {
  const error = new Error("Lock request failed");
  const { locks } = manager(Promise.reject(error));
  const held = holdWebLock(locks, "draft");
  await expect(held.acquired).rejects.toBe(error);
  held.release();
});
