import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { Timeline } from "@/client/features/chat/reconcile";
import type {
  AccountFence,
  ScopeCapture,
  HistoryFence,
  SnapshotLabels,
  HistoryCache,
} from "@/client/features/cache/model";
import { historyCache } from "@/client/features/cache/storage";

/** A projection lease is captured before its producing network request. */
export interface ProjectionLease {
  capture: ScopeCapture;
  lifetime: number;
  source: TimelineProjection;
}
export class TimelineProjection {
  private lifetime = 0;
  private active = true;
  private tail: Promise<unknown> = Promise.resolve();
  private fence: HistoryFence | null = null;
  private latestCapture: ScopeCapture | null = null;
  constructor(
    private readonly account: AccountFence,
    private readonly owner: OwnerScope,
    private readonly labels: () => SnapshotLabels,
    private readonly cache: HistoryCache = historyCache,
  ) {}
  async capture(): Promise<ProjectionLease | null> {
    const lifetime = this.lifetime;
    await this.tail;
    if (!this.active || lifetime !== this.lifetime) return null;
    const result = await this.cache.captureScope(this.account, this.owner);
    if (result.kind !== "ok" || !this.active || lifetime !== this.lifetime)
      return null;
    this.latestCapture = result.value;
    return { capture: result.value, lifetime, source: this };
  }
  /** Live frames reuse prior authorization; optional disk work never gates display. */
  currentLease(): ProjectionLease | null {
    return this.active && this.fence
      ? { capture: this.fence, lifetime: this.lifetime, source: this }
      : null;
  }
  accepted(lease: ProjectionLease | null, state: Timeline, replace: boolean) {
    if (
      !lease ||
      lease.source !== this ||
      !this.active ||
      lease.lifetime !== this.lifetime
    )
      return;
    // Browsing an older range must not replace the saved newest window. Mutation
    // observation still withholds stale disk content at the connection boundary.
    if (state.mode !== "following") return;
    // A socket frame or older-page update can be ahead of replay. Partial
    // reconciliation may also contain a deletion: keeping the previous saved
    // window would expose its old body if the next replay page never arrives.
    if (
      state.messages.some(
        (message) => message.updatedSequence > state.cursor.sequence,
      )
    ) {
      void this.withhold();
      return;
    }
    const projection = {
      cursor: state.cursor,
      messages: state.messages,
      nextBefore: state.nextBefore,
      labels: this.labels(),
    };
    this.tail = this.tail
      .then(async () => {
        if (!this.active || lease.lifetime !== this.lifetime) return;
        const authorized = await this.cache.authorizeScope(
          lease.capture,
          state.cursor.generation,
        );
        if (
          authorized.kind !== "ok" ||
          !this.active ||
          lease.lifetime !== this.lifetime
        )
          return;
        this.fence = authorized.value;
        await this.cache.save(authorized.value, projection, { replace });
      })
      .catch(() => {});
  }
  /** Observed edits must never leave an older body available to cold cache entry. */
  async withhold() {
    const fence = this.fence;
    this.fence = null;
    this.latestCapture = null;
    this.lifetime++;
    this.tail = this.tail
      .then(async () => {
        if (fence) await this.cache.invalidateOwner(fence);
        else {
          const capture = await this.cache.captureScope(
            this.account,
            this.owner,
          );
          if (capture.kind === "ok")
            await this.cache.invalidateOwner(capture.value);
        }
        this.fence = null;
        this.latestCapture = null;
      })
      .catch(() => {});
    await this.tail;
  }
  async recheck() {
    await this.tail;
    const fence = this.fence ?? this.latestCapture;
    if (!this.active || !fence) return true;
    const result = await this.cache.recheck(fence);
    return result.kind !== "stale";
  }
  dispose() {
    this.active = false;
    this.lifetime++;
  }
}
