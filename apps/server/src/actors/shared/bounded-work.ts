export const ACTOR_RPC_TIMEOUT_MS = 2_000;
export const ACTOR_WORK_BUDGET_MS = 5_000;

export type WorkResult<T> = { ok: true; value: T } | { ok: false };

/** A timeout retires the caller's wait, never the still-running RPC's slot. */
export class BoundedWork {
  private active = 0;
  private readonly capacityWaiters = new Set<() => void>();
  private readonly keys = new Set<string>();
  constructor(
    private readonly concurrency = 8,
    private readonly timeoutMs = ACTOR_RPC_TIMEOUT_MS,
  ) {}

  async run<T>(
    operation: () => Promise<T>,
    deadline: number,
    key?: string,
    timeoutMs = this.timeoutMs,
  ): Promise<WorkResult<T>> {
    const remaining = deadline - Date.now();
    if (
      remaining <= 0 ||
      this.active >= this.concurrency ||
      (key !== undefined && this.keys.has(key))
    )
      return { ok: false };
    this.active++;
    if (key !== undefined) this.keys.add(key);
    const result = Promise.resolve()
      .then(operation)
      .then<WorkResult<T>, WorkResult<T>>(
        (value) => ({ ok: true, value }),
        () => ({ ok: false }),
      )
      .finally(() => {
        this.active--;
        if (key !== undefined) this.keys.delete(key);
        this.startWaiting();
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        result,
        new Promise<WorkResult<T>>((resolve) => {
          timer = setTimeout(
            () => resolve({ ok: false }),
            Math.min(remaining, timeoutMs),
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private startWaiting() {
    while (this.active < this.concurrency) {
      const start = this.capacityWaiters.values().next().value;
      if (!start) return;
      this.capacityWaiters.delete(start);
      // Admission is synchronous; expired or duplicate work leaves this slot free.
      start();
    }
  }

  private whenAvailable<T>(
    operation: () => Promise<T>,
    deadline: number,
    key?: string,
  ): Promise<WorkResult<T>> {
    if (this.active < this.concurrency)
      return this.run(operation, deadline, key);
    const remaining = deadline - Date.now();
    if (remaining <= 0 || (key !== undefined && this.keys.has(key)))
      return Promise.resolve({ ok: false });
    return new Promise<WorkResult<T>>((resolve) => {
      const start = () => {
        clearTimeout(timer);
        resolve(this.run(operation, deadline, key));
      };
      // A waiter registers once and keeps its timer until admission or expiry.
      const timer = setTimeout(() => {
        this.capacityWaiters.delete(start);
        resolve({ ok: false });
      }, remaining);
      this.capacityWaiters.add(start);
    });
  }

  async map<T, U>(
    entries: readonly T[],
    operation: (entry: T) => Promise<U>,
    deadline = Date.now() + ACTOR_WORK_BUDGET_MS,
    key?: (entry: T) => string,
  ): Promise<WorkResult<U>[]> {
    const results = new Array<WorkResult<U>>(entries.length);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(entries.length, this.concurrency) },
        async () => {
          while (next < entries.length) {
            const index = next++;
            results[index] = await this.whenAvailable(
              () => operation(entries[index]!),
              deadline,
              key?.(entries[index]!),
            );
          }
        },
      ),
    );
    return results;
  }
}

const pools = new WeakMap<
  DurableObjectStorage,
  {
    hints: BoundedWork;
    maintenance: BoundedWork;
  }
>();

/** Pools survive overlapping requests/passes; hint traffic cannot consume maintenance slots. */
export function actorWork(
  storage: DurableObjectStorage,
  purpose: "hints" | "maintenance",
) {
  let pool = pools.get(storage);
  if (!pool) {
    pool = {
      hints: new BoundedWork(8),
      maintenance: new BoundedWork(4),
    };
    pools.set(storage, pool);
  }
  return pool[purpose];
}
