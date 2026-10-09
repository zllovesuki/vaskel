import type { QueryClient } from "@tanstack/react-query";
import { OWNER_MEMBER_LIMIT } from "@vaskel/contracts/resources";
import { type OwnerScope } from "@vaskel/contracts/messaging";
import {
  PRESENCE_OWNER_PAGE_SIZE,
  PRESENCE_MEMBER_PAGE_SIZE,
  PRESENCE_REPAIR_MS,
  PRESENCE_SAMPLE_MAX_AGE_MS,
  type PresenceSample,
  type PresenceScopeRequest,
  type PresenceScopeResult,
} from "@vaskel/contracts/presence";
import { presenceKey } from "@/client/api/presence";

export interface PresenceData {
  token: string;
  samples: Record<string, PresenceSample>;
  complete: boolean;
}
interface Scope {
  owner: OwnerScope;
  references: number;
  after?: string;
  pending: boolean;
  running: boolean;
  trailing: boolean;
  full: boolean;
  targets: Set<string>;
}
const identity = (owner: OwnerScope) => `${owner.kind}:${owner.id}`;

/** One document's fair, bounded sampler. Query owns accepted data, never membership. */
export class PresenceOwner {
  private readonly scopes = new Map<string, Scope>();
  private readonly queue: Scope[] = [];
  private enabled = false;
  private denied = new Set<string>();
  private account: string | undefined;
  private disposed = false;
  private running = false;
  private wake: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private repair: ReturnType<typeof setInterval> | undefined;
  private request: AbortController | undefined;

  constructor(
    private readonly dependencies: {
      client: QueryClient;
      userId: string;
      token(owner: OwnerScope): string;
      accountCurrent(token: string): boolean;
      sample(
        scopes: PresenceScopeRequest[],
        signal: AbortSignal,
      ): Promise<PresenceScopeResult[]>;
    },
  ) {}

  setDenied(owners: readonly string[]) {
    this.denied = new Set(owners);
    for (const scope of this.scopes.values())
      if (this.denied.has(identity(scope.owner))) this.clear(scope);
  }

  private allowed(owner: OwnerScope) {
    return !this.denied.has(identity(owner));
  }

  attach() {
    this.disposed = false;
  }

  register(owner: OwnerScope) {
    const key = identity(owner);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = {
        owner,
        references: 0,
        pending: false,
        running: false,
        trailing: false,
        full: true,
        targets: new Set(),
      };
      this.scopes.set(key, scope);
      this.enqueue(scope);
    }
    scope.references++;
    this.schedule();
    return () => {
      if (!scope || this.scopes.get(key) !== scope || --scope.references > 0)
        return;
      this.scopes.delete(key);
      this.clear(scope);
    };
  }

  setEnabled(enabled: boolean, account?: string) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    clearInterval(this.repair);
    if (enabled) {
      this.account = account;
      this.expire();
      this.refresh();
      this.repair = setInterval(() => this.refresh(), PRESENCE_REPAIR_MS);
    } else {
      clearTimeout(this.wake);
      this.wake = undefined;
    }
  }

  refresh = (owner?: OwnerScope, userId?: string) => {
    if (this.disposed) return;
    for (const scope of this.scopes.values()) {
      if (owner && identity(owner) !== identity(scope.owner)) continue;
      if (userId) {
        scope.targets.add(userId);
        if (scope.targets.size <= OWNER_MEMBER_LIMIT) {
          if (!scope.running) this.enqueue(scope);
          continue;
        }
        scope.targets.clear();
      }
      // Finish pagination before a repair scan or targeted hints, avoiding starvation.
      if (scope.running || scope.after) scope.trailing = true;
      else {
        scope.full = true;
        this.enqueue(scope);
      }
    }
    this.schedule();
  };

  private enqueue(scope: Scope) {
    if (scope.pending || this.scopes.get(identity(scope.owner)) !== scope)
      return;
    scope.pending = true;
    this.queue.push(scope);
  }

  private schedule() {
    if (
      !this.enabled ||
      this.disposed ||
      this.running ||
      this.wake !== undefined ||
      !this.queue.length
    )
      return;
    this.wake = setTimeout(() => {
      this.wake = undefined;
      void this.pass();
    }, 0);
  }

  private accountCurrent() {
    return (
      this.account !== undefined &&
      this.dependencies.accountCurrent(this.account)
    );
  }

  private current(scope: Scope, token: string) {
    return (
      !this.disposed &&
      this.accountCurrent() &&
      this.scopes.get(identity(scope.owner)) === scope &&
      this.allowed(scope.owner) &&
      this.dependencies.token(scope.owner) === token
    );
  }

  private async pass() {
    if (!this.enabled || this.disposed || !this.accountCurrent()) return;
    const batch: {
      scope: Scope;
      token: string;
      request: PresenceScopeRequest;
    }[] = [];
    while (this.queue.length && batch.length < PRESENCE_OWNER_PAGE_SIZE) {
      const scope = this.queue.shift()!;
      scope.pending = false;
      if (this.scopes.get(identity(scope.owner)) !== scope) continue;
      if (!this.allowed(scope.owner)) {
        this.clear(scope);
        continue;
      }
      scope.running = true;
      let request: PresenceScopeRequest;
      if (scope.full || scope.after) {
        request = {
          owner: scope.owner,
          ...(scope.after ? { after: scope.after } : {}),
        };
        scope.full = false;
      } else {
        const userIds = [...scope.targets].slice(0, PRESENCE_MEMBER_PAGE_SIZE);
        for (const id of userIds) scope.targets.delete(id);
        request = { owner: scope.owner, userIds };
      }
      batch.push({
        scope,
        token: this.dependencies.token(scope.owner),
        request,
      });
    }
    if (!batch.length) return;
    this.running = true;
    const controller = new AbortController();
    this.request = controller;
    try {
      const results = await this.dependencies.sample(
        batch.map(({ request }) => request),
        controller.signal,
      );
      for (const { scope, token, request } of batch) {
        if (!this.current(scope, token)) continue;
        const result = results.find(
          (entry) => identity(entry.owner) === identity(scope.owner),
        );
        if (result?.kind !== "sampled") {
          if (result?.kind === "denied" || !("userIds" in request))
            this.clear(scope);
          else this.mergeTargets(scope, token, request.userIds);
          continue;
        }
        if ("userIds" in request) {
          this.mergeTargets(scope, token, request.userIds, result.samples);
          continue;
        }
        const after = request.after;
        const key = presenceKey(this.dependencies.userId, scope.owner);
        const previous = after
          ? this.dependencies.client.getQueryData<PresenceData>(key)
          : undefined;
        this.dependencies.client.setQueryData<PresenceData>(key, {
          token,
          samples: {
            ...(previous?.token === token ? previous.samples : {}),
            ...Object.fromEntries(
              result.samples.map((sample) => [sample.userId, sample]),
            ),
          },
          complete: result.nextCursor === null,
        });
        // A malformed repeating cursor cannot create an unbounded polling loop.
        if (result.nextCursor && (!after || result.nextCursor > after)) {
          scope.after = result.nextCursor;
          this.enqueue(scope);
        } else delete scope.after;
      }
    } catch {
      for (const { scope, token, request } of batch)
        if (this.current(scope, token)) {
          if ("userIds" in request)
            this.mergeTargets(scope, token, request.userIds);
          else this.clear(scope);
        }
    } finally {
      for (const { scope, token } of batch) {
        scope.running = false;
        if (this.scopes.get(identity(scope.owner)) !== scope || this.disposed)
          continue;
        if (!this.current(scope, token)) {
          this.clear(scope);
          if (this.accountCurrent() && this.allowed(scope.owner))
            this.enqueue(scope);
        }
        if (!scope.after && scope.trailing) {
          scope.trailing = false;
          scope.full = true;
          this.enqueue(scope);
        }
        if (scope.targets.size) this.enqueue(scope);
      }
      this.running = false;
      this.request = undefined;
      this.expire();
      this.schedule();
    }
  }

  private mergeTargets(
    scope: Scope,
    token: string,
    userIds: string[],
    samples?: PresenceSample[],
  ) {
    const key = presenceKey(this.dependencies.userId, scope.owner);
    const previous = this.dependencies.client.getQueryData<PresenceData>(key);
    const retained = previous?.token === token ? previous : undefined;
    const merged = { ...retained?.samples };
    for (const userId of userIds) {
      delete merged[userId];
      if (!samples) merged[userId] = { userId, state: "unknown" };
    }
    const requested = new Set(userIds);
    for (const sample of samples ?? [])
      if (requested.has(sample.userId)) merged[sample.userId] = sample;
    this.dependencies.client.setQueryData<PresenceData>(key, {
      token,
      samples: merged,
      complete: retained?.complete ?? false,
    });
  }

  private clear(scope: Scope) {
    delete scope.after;
    scope.full = true;
    scope.targets.clear();
    // Teardown follows the coordinator's synchronous private-cache purge.
    // Updating only retained data cannot resurrect a retired account key.
    this.dependencies.client.setQueriesData<PresenceData>(
      {
        queryKey: presenceKey(this.dependencies.userId, scope.owner),
        exact: true,
      },
      (data) =>
        data && {
          token: this.dependencies.token(scope.owner),
          samples: {},
          complete: false,
        },
    );
  }

  /** Expiry changes the shared query once, without a clock/interval per consumer. */
  private expire() {
    clearTimeout(this.expiry);
    if (this.disposed) return;
    let next = Infinity;
    const now = Date.now();
    for (const scope of this.scopes.values()) {
      const key = presenceKey(this.dependencies.userId, scope.owner);
      const data = this.dependencies.client.getQueryData<PresenceData>(key);
      if (!data) continue;
      let changed = false;
      const samples = Object.fromEntries(
        Object.entries(data.samples).map(([id, sample]) => {
          if (sample.state === "unknown") return [id, sample];
          const remaining = sample.sampledAt + PRESENCE_SAMPLE_MAX_AGE_MS - now;
          if (remaining <= 0) {
            changed = true;
            return [id, { userId: id, state: "unknown" as const }];
          }
          next = Math.min(next, remaining);
          return [id, sample];
        }),
      );
      if (changed)
        this.dependencies.client.setQueryData<PresenceData>(key, {
          ...data,
          samples,
        });
    }
    if (Number.isFinite(next))
      this.expiry = setTimeout(() => this.expire(), next);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.repair);
    clearTimeout(this.wake);
    clearTimeout(this.expiry);
    this.request?.abort();
    this.scopes.clear();
    this.queue.length = 0;
  }
}
