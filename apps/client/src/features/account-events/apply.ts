import {
  replaceEqualDeep,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { OwnerActivity } from "@vaskel/contracts/activity";
import type { AccountEventFrame } from "@vaskel/contracts/account-events";
import type { MediaRoomRef } from "@vaskel/contracts/media";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import {
  accountActivityKey,
  activityKey,
  ownerActivityKey,
  ownerIdentity,
  type ActivityData,
  type OwnerActivityData,
} from "@/client/api/activity";
import { blockKey } from "@/client/api/blocks";
import { notificationsKey } from "@/client/api/notifications";
import { administrationKey } from "@/client/api/administration";
import {
  directoryKey,
  mediaRoomKey,
  mediaRoomsKey,
  membersKey,
  membersRootKey,
} from "@/client/api/client";
import { withActivityCounts } from "@/client/features/activity/counts";

const SEEN_LIMIT = 512;
export const INVALIDATION_THROTTLE_MS = 2_000;
interface PendingRefresh {
  last: number;
  dirty: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout> | undefined;
  run: () => Promise<unknown>;
  visibleOnly: boolean;
}

export interface AccountEventEffects {
  /** Retires durable history; directory/access changes also retire scoped search copies. */
  contentChanged(owner: OwnerScope, accessChanged?: boolean): void;
  /** Restarts content reads whose hints may have been missed while disconnected. */
  resync(): void;
  /** Presence samples have their own shared, visibility-aware owner. */
  presenceChanged(owner?: OwnerScope, userId?: string): void;
  /** Refreshes active participation; no room means reconnect/resync. */
  callChanged(room?: MediaRoomRef): Promise<unknown>;
  /** A fresh arrival; replay and reconnects never announce one. */
  messageArrived(
    notice: Extract<AccountEventFrame, { type: "activity" }>,
  ): void;
}

/**
 * What one account's connection remembers between hints: which hints were
 * already applied and when each query was last asked for an authoritative refresh.
 */
export class NoticeMemory {
  private readonly seen = new Set<string>();
  private readonly refreshes = new Map<string, PendingRefresh>();
  private disposed = false;
  private visibilityWait:
    { promise: Promise<void>; resolve: () => void } | undefined;
  isCurrent = () => !this.disposed;
  hidden = () => globalThis.document?.visibilityState === "hidden";
  /** One wait per hidden period, shared by metadata reads and trailing repairs. */
  async waitUntilVisible() {
    while (!this.disposed && this.hidden()) {
      if (!this.visibilityWait) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        this.visibilityWait = { promise, resolve };
      }
      await this.visibilityWait.promise;
    }
  }
  resume = () => {
    if (!this.disposed && this.hidden()) return;
    this.visibilityWait?.resolve();
    this.visibilityWait = undefined;
  };
  /** True the first time a key is seen; the set is bounded and forgets the oldest. */
  remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
  /**
   * A refresh has one target, one in-flight read and one dirty flag. Hints
   * received during that read always cause a later authoritative read, without
   * canceling another owner's work on the shared account query.
   */
  refresh(
    identity: string,
    run: () => Promise<unknown>,
    now: number,
    visibleOnly = false,
  ): "invalidated" | "scheduled" {
    let pending = this.refreshes.get(identity);
    if (!pending) {
      pending = {
        last: -Infinity,
        dirty: false,
        running: false,
        run,
        visibleOnly,
      };
      this.refreshes.set(identity, pending);
    }
    pending.run = run;
    pending.dirty = true;
    if (!pending.running && now - pending.last >= INVALIDATION_THROTTLE_MS) {
      this.startRefresh(pending, now);
      return "invalidated";
    }
    this.scheduleRefresh(pending, now);
    return "scheduled";
  }
  private startRefresh(pending: PendingRefresh, now: number) {
    if (this.disposed) return;
    clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.running = true;
    const run = () => {
      if (this.disposed) return;
      pending.last = now;
      pending.dirty = false;
      return pending.run();
    };
    // Waiting does not consume the dirty hints: the eventual read covers all
    // hints received before it starts, without a timer per hidden update.
    const work =
      pending.visibleOnly && this.hidden()
        ? this.waitUntilVisible().then(() => {
            now = Date.now();
            return run();
          })
        : run();
    void Promise.resolve(work)
      .catch(() => {})
      .finally(() => {
        pending.running = false;
        if (pending.dirty) this.scheduleRefresh(pending, Date.now());
      });
  }
  private scheduleRefresh(pending: PendingRefresh, now: number) {
    if (this.disposed || pending.running || pending.timer !== undefined) return;
    pending.timer = setTimeout(
      () => {
        pending.timer = undefined;
        this.startRefresh(pending, Date.now());
      },
      Math.max(0, INVALIDATION_THROTTLE_MS - (now - pending.last)),
    );
  }
  dispose() {
    this.disposed = true;
    this.resume();
    for (const pending of this.refreshes.values()) clearTimeout(pending.timer);
    this.refreshes.clear();
  }
}

export type NoticeOutcome = "applied" | "invalidated" | "scheduled" | "ignored";

/** A pre-existing read may have taken its snapshot before this hint arrived. */
async function refreshQueries(
  client: QueryClient,
  queryKey: QueryKey,
  current: () => boolean,
  visibility?: NoticeMemory,
) {
  if (visibility?.hidden()) await visibility.waitUntilVisible();
  if (!current()) return;
  const alreadyFetching = client.isFetching({ queryKey }) > 0;
  await client.invalidateQueries({ queryKey }, { cancelRefetch: false });
  if (alreadyFetching && visibility?.hidden())
    await visibility.waitUntilVisible();
  if (alreadyFetching && current())
    await client.invalidateQueries({ queryKey }, { cancelRefetch: false });
}

function refreshMetadata(
  client: QueryClient,
  queryKey: QueryKey,
  identity: string,
  memory: NoticeMemory,
  now: number,
): NoticeOutcome {
  return memory.refresh(
    identity,
    () => refreshQueries(client, queryKey, memory.isCurrent, memory),
    now,
    true,
  );
}

/** Preserve immediate visible invalidations; coalesce only their hidden work. */
function invalidateMetadata(
  client: QueryClient,
  queryKey: QueryKey,
  memory: NoticeMemory,
  now: number,
) {
  if (memory.hidden())
    refreshMetadata(client, queryKey, JSON.stringify(queryKey), memory, now);
  else void refreshQueries(client, queryKey, memory.isCurrent, memory);
}

function invalidateActivity(
  client: QueryClient,
  userId: string,
  owner: OwnerScope,
  memory: NoticeMemory,
  now: number,
): NoticeOutcome {
  const result = refreshMetadata(
    client,
    accountActivityKey(userId),
    "activity:account",
    memory,
    now,
  );
  // Owner continuations are independent queries; only this owner's is dirty.
  const ownerKey = ownerActivityKey(userId, owner);
  if (client.getQueryCache().findAll({ queryKey: ownerKey }).length > 0)
    refreshMetadata(
      client,
      ownerKey,
      `activity:owner:${ownerIdentity(owner)}`,
      memory,
      now,
    );
  return result;
}
function invalidateDirectory(
  client: QueryClient,
  userId: string,
  memory: NoticeMemory,
  now: number,
): NoticeOutcome {
  return refreshMetadata(
    client,
    directoryKey(userId),
    "directory",
    memory,
    now,
  );
}

/** Rewrites one owner's entries in the account and owner activity pages. */
export function updateActivity(
  client: QueryClient,
  userId: string,
  owner: OwnerScope,
  update: (entry: OwnerActivity) => OwnerActivity,
) {
  client.setQueriesData<ActivityData>(
    { queryKey: accountActivityKey(userId) },
    (data) =>
      data &&
      replaceEqualDeep(data, {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          owners: page.owners.map(update),
        })),
      }),
  );
  client.setQueriesData<OwnerActivityData>(
    { queryKey: ownerActivityKey(userId, owner) },
    (data) =>
      data &&
      replaceEqualDeep(data, { ...data, pages: data.pages.map(update) }),
  );
}

/** Hints refresh authorized reads. Only private read progress patches badge state. */
export function applyAccountEvent(
  client: QueryClient,
  userId: string,
  notice: AccountEventFrame,
  memory: NoticeMemory,
  effects: AccountEventEffects,
  now = Date.now(),
): NoticeOutcome {
  switch (notice.type) {
    case "activity": {
      const identity = ownerIdentity(notice.owner);
      const key = `activity:${identity}:${notice.channelId}:${notice.generation}:${notice.sequence}`;
      if (!memory.remember(key)) return "ignored";
      effects.messageArrived(notice);
      return invalidateActivity(client, userId, notice.owner, memory, now);
    }
    case "mutation": {
      const identity = ownerIdentity(notice.owner);
      const key = `mutation:${identity}:${notice.channelId}:${notice.generation}:${notice.sequence}`;
      if (!memory.remember(key)) return "ignored";
      effects.contentChanged(notice.owner);
      return invalidateActivity(client, userId, notice.owner, memory, now);
    }
    case "read": {
      const identity = ownerIdentity(notice.owner);
      const key = `read:${identity}:${notice.channelId}:${notice.generation}:${notice.sequence}`;
      if (!memory.remember(key)) return "ignored";
      let applied = false;
      let partial = false;
      let found = false;
      updateActivity(client, userId, notice.owner, (entry) => {
        if (ownerIdentity(entry.owner) !== identity) return entry;
        if (entry.generation !== notice.generation) return entry;
        const channel = entry.channels.find(
          (item) => item.channelId === notice.channelId,
        );
        if (!channel) return entry;
        found = true;
        const readSequence = Math.max(channel.readSequence, notice.sequence);
        if (readSequence === channel.readSequence) return entry;
        const caughtUp = readSequence >= channel.lastCreatedSequence;
        if (caughtUp) applied = true;
        else partial = true;
        return {
          ...entry,
          channels: entry.channels.map((item) =>
            item === channel
              ? withActivityCounts({ ...item, readSequence })
              : item,
          ),
        };
      });
      // A cursor that moved but did not catch up leaves the count unknown.
      if (!found || partial)
        return invalidateActivity(client, userId, notice.owner, memory, now);
      return applied ? "applied" : "ignored";
    }
    case "directory": {
      effects.contentChanged(notice.owner, true);
      effects.presenceChanged(notice.owner);
      invalidateDirectory(client, userId, memory, now);
      invalidateActivity(client, userId, notice.owner, memory, now);
      invalidateMetadata(client, membersKey(userId, notice.owner), memory, now);
      if (notice.owner.kind === "server")
        void client.invalidateQueries({
          queryKey: administrationKey(userId, notice.owner.id),
        });
      else invalidateMetadata(client, blockKey(userId), memory, now);
      return "invalidated";
    }
    case "presence": {
      effects.presenceChanged(notice.owner, notice.userId);
      return "invalidated";
    }
    case "occupancy":
    case "call": {
      const room = { owner: notice.owner, channelId: notice.channelId };
      const result = memory.refresh(
        `call:${ownerIdentity(notice.owner)}:${notice.channelId}`,
        () =>
          Promise.all([
            effects.callChanged(room),
            refreshQueries(
              client,
              mediaRoomKey(userId, notice.owner, notice.channelId),
              memory.isCurrent,
            ),
          ]),
        now,
      );
      return notice.type === "occupancy"
        ? invalidateDirectory(client, userId, memory, now)
        : result;
    }
    case "dm_policy": {
      invalidateMetadata(client, blockKey(userId), memory, now);
      return "invalidated";
    }
    // Hidden tabs still decide message sounds, so settings refresh without waiting.
    case "notification_settings": {
      void client.invalidateQueries({ queryKey: notificationsKey(userId) });
      return "invalidated";
    }
    case "ready": {
      effects.resync();
      effects.presenceChanged();
      void effects.callChanged();
      invalidateMetadata(client, directoryKey(userId), memory, now);
      invalidateMetadata(client, activityKey(userId), memory, now);
      invalidateMetadata(client, membersRootKey(userId), memory, now);
      invalidateMetadata(client, blockKey(userId), memory, now);
      void client.invalidateQueries({ queryKey: notificationsKey(userId) });
      void client.invalidateQueries({ queryKey: mediaRoomsKey(userId) });
      void client.invalidateQueries({ queryKey: administrationKey(userId) });
      return "invalidated";
    }
    case "pong":
    case "revoked":
    case "lease_expired":
      return "ignored";
  }
}
