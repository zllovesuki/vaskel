import { z } from "zod";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { AccountPreferences } from "@vaskel/contracts/preferences";
import {
  CacheInvalidationSchema,
  DisplayLanguageHintSchema,
  type AccountCapture,
  type AccountFence,
  type CacheInvalidation,
  type CacheResult,
  type CacheUnavailableReason,
  type CachedAccount,
  type CachedSnapshot,
  type HistoryCache,
  type HistoryFence,
  type HistoryProjection,
  type ScopeCapture,
} from "@/client/features/cache/model";
import {
  CacheDatabase,
  draftStores,
  type CacheTransaction,
  OPEN_TIMEOUT_MS,
  invalid,
  StorageFailure,
  failureReason,
} from "./database";
import * as accountOperations from "./account";
import * as historyOperations from "./history";
import * as draftOperations from "./drafts";
import type { DraftPersistence } from "@/client/features/drafts/model";

class BrowserHistoryCache implements HistoryCache {
  private database: CacheDatabase | undefined;
  private connection: Promise<CacheDatabase> | undefined;
  private channel: BroadcastChannel | undefined;
  private listeners = new Set<
    (event: CacheInvalidation, source: "local" | "remote") => void
  >();
  private disabled: CacheUnavailableReason | undefined;
  private closed = false;

  private get origin(): string {
    if (typeof window === "undefined") throw new StorageFailure("unsupported");
    return window.location.origin;
  }

  private listen() {
    if (
      this.channel ||
      this.closed ||
      typeof window === "undefined" ||
      typeof BroadcastChannel === "undefined"
    )
      return;
    try {
      this.channel = new BroadcastChannel("vaskel-history-invalidations-v1");
      this.channel.onmessage = (message: MessageEvent<unknown>) => {
        const parsed = CacheInvalidationSchema.safeParse(message.data);
        if (parsed.success && parsed.data.origin === this.origin)
          this.notify(parsed.data, "remote");
      };
    } catch {
      // Durable comparisons remain authoritative when broadcast delivery is unavailable.
    }
  }

  private notify(event: CacheInvalidation, source: "local" | "remote") {
    for (const listener of this.listeners) {
      try {
        listener(event, source);
      } catch {
        /* A view cannot affect a committed transaction. */
      }
    }
    if (source === "local") {
      try {
        this.channel?.postMessage(event);
      } catch {
        /* Focus rechecks still apply. */
      }
    }
  }

  private open(): Promise<CacheDatabase> {
    return (this.connection ??= this.connect());
  }

  private async connect(): Promise<CacheDatabase> {
    this.listen();
    if (typeof indexedDB === "undefined")
      throw new StorageFailure("unsupported");
    const database = (this.database ??= new CacheDatabase());
    if (database.isOpen()) return database;
    return new Promise((resolve, reject) => {
      const fail = (reason: CacheUnavailableReason) => {
        clearTimeout(timer);
        database.close();
        reject(new StorageFailure(reason));
      };
      const timer = setTimeout(() => fail("timeout"), OPEN_TIMEOUT_MS);
      const blocked = () => fail("blocked");
      database.on("blocked", blocked);
      database.on("versionchange", () => {
        database.close();
        this.database = undefined;
        this.connection = undefined;
        this.notify({ type: "cache", origin: this.origin }, "local");
      });
      void database
        .open()
        .then(() => {
          if (this.closed) fail("closed");
          else {
            database.backendDB().addEventListener("close", () => {
              this.database = undefined;
              this.connection = undefined;
              this.disabled = "storage";
              this.notify({ type: "cache", origin: this.origin }, "local");
            });
            resolve(database);
          }
        }, reject)
        .finally(() => {
          clearTimeout(timer);
          database.on("blocked").unsubscribe(blocked);
        });
    });
  }

  /** Every operation overlaps the control stores; only IDB requests are awaited inside. */
  private async run<T>(
    work: (
      tx: CacheTransaction,
      events: CacheInvalidation[],
    ) => Promise<CacheResult<T>>,
    allowDisabled = false,
    draftsOnly = false,
  ): Promise<CacheResult<T>> {
    if (this.closed) return { kind: "unavailable", reason: "closed" };
    if (this.disabled && !allowDisabled)
      return { kind: "unavailable", reason: this.disabled };
    let started = false;
    try {
      const database = await this.open();
      if (this.closed) return { kind: "unavailable", reason: "closed" };
      if (this.disabled && !allowDisabled)
        return { kind: "unavailable", reason: this.disabled };
      const events: CacheInvalidation[] = [];
      started = true;
      const result = await database.transaction(
        "rw!",
        draftsOnly ? draftStores : database.tables,
        // Dexie detects async scopes to preserve its transaction across native awaits.
        async () => work(database, events),
      );
      for (const event of events) this.notify(event, "local");
      return result;
    } catch (error) {
      if (this.closed) return { kind: "unavailable", reason: "closed" };
      if (!started) {
        this.database?.close();
        this.database = undefined;
        this.connection = undefined;
      }
      const reason = failureReason(error);
      if (draftsOnly) return { kind: "unavailable", reason };
      this.disabled = reason;
      if (typeof window !== "undefined")
        this.notify({ type: "cache", origin: this.origin }, "local");
      return { kind: "unavailable", reason };
    }
  }

  readonly drafts: DraftPersistence = {
    targets: (account) =>
      this.run(
        (tx) => draftOperations.targets(this.origin, tx, account),
        true,
        true,
      ),
    load: (account, target) =>
      this.run(
        (tx) => draftOperations.load(this.origin, tx, account, target),
        true,
        true,
      ),
    restore: (fence, id) =>
      this.run(
        (tx) => draftOperations.restore(this.origin, tx, fence, id),
        true,
        true,
      ),
    save: (fence, record, files) =>
      this.run(
        (tx) => draftOperations.save(this.origin, tx, fence, record, files),
        true,
        true,
      ),
    remove: (fence, id) =>
      this.run(
        (tx) => draftOperations.remove(this.origin, tx, fence, id),
        true,
        true,
      ),
    retire: (account, owner) =>
      this.run(
        (tx, events) =>
          draftOperations.retire(this.origin, tx, events, account, owner),
        true,
        true,
      ),
  };

  captureAccount(): Promise<CacheResult<AccountCapture>> {
    return this.run((tx) => accountOperations.captureAccount(this.origin, tx));
  }

  activateAccount(
    capture: AccountCapture,
    account: { accountId: string; label: string },
  ): Promise<CacheResult<AccountFence>> {
    return this.run((tx, events) =>
      accountOperations.activateAccount(
        this.origin,
        tx,
        events,
        capture,
        account,
      ),
    );
  }

  saveDisplayLanguage(
    fence: AccountFence,
    preferences: AccountPreferences,
  ): Promise<CacheResult<undefined>> {
    // An unsaved browser fallback never becomes a remembered account setting.
    if (preferences.language === null) return Promise.resolve({ kind: "miss" });
    const parsed = DisplayLanguageHintSchema.safeParse({
      fence,
      ...preferences,
    });
    if (!parsed.success) return Promise.resolve(invalid());
    return this.run((tx, events) =>
      accountOperations.saveDisplayLanguage(
        this.origin,
        tx,
        events,
        fence,
        preferences,
        parsed.data,
      ),
    );
  }

  captureScope(
    account: AccountFence,
    owner: OwnerScope,
  ): Promise<CacheResult<ScopeCapture>> {
    return this.run((tx, events) =>
      historyOperations.captureScope(this.origin, tx, events, account, owner),
    );
  }

  authorizeScope(
    capture: ScopeCapture,
    generation: string,
  ): Promise<CacheResult<HistoryFence>> {
    if (!z.uuid().safeParse(generation).success)
      return Promise.resolve(invalid());
    return this.run((tx, events) =>
      historyOperations.authorizeScope(
        this.origin,
        tx,
        events,
        capture,
        generation,
      ),
    );
  }

  save(
    fence: HistoryFence,
    projection: HistoryProjection,
    options: { replace: boolean },
  ): Promise<CacheResult<CachedSnapshot>> {
    return this.run((tx, events) =>
      historyOperations.save(
        this.origin,
        tx,
        events,
        fence,
        projection,
        options,
      ),
    );
  }

  readAccount(): Promise<CacheResult<CachedAccount>> {
    return this.run((tx) => accountOperations.readAccount(this.origin, tx));
  }

  readSnapshot(
    fence: HistoryFence,
    channelId: string,
  ): Promise<CacheResult<CachedSnapshot>> {
    return this.run((tx) =>
      historyOperations.readSnapshot(this.origin, tx, fence, channelId),
    );
  }

  recheck(
    fence: AccountCapture | ScopeCapture,
  ): Promise<CacheResult<undefined>> {
    return this.run((tx) => historyOperations.recheck(this.origin, tx, fence));
  }

  invalidateAccount(capture: AccountCapture): Promise<CacheResult<undefined>> {
    return this.run(
      (tx, events) =>
        accountOperations.invalidateAccount(this.origin, tx, events, capture),
      true,
    );
  }

  invalidateOwner(capture: ScopeCapture): Promise<CacheResult<undefined>> {
    return this.run((tx, events) =>
      historyOperations.invalidateOwner(this.origin, tx, events, capture),
    );
  }

  clearHistory(): Promise<CacheResult<undefined>> {
    return this.run(
      (tx, events) => accountOperations.clearHistory(this.origin, tx, events),
      true,
    );
  }

  clear(): Promise<CacheResult<undefined>> {
    return this.run(
      (tx, events) => accountOperations.clear(this.origin, tx, events),
      true,
    );
  }

  subscribe(
    listener: (event: CacheInvalidation, source: "local" | "remote") => void,
  ): () => void {
    this.listeners.add(listener);
    this.listen();
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.database?.close();
    this.channel?.close();
    this.listeners.clear();
  }
}

/** A separate adapter is useful for independently-lived browser documents/tests. */
export const createHistoryCache = (): HistoryCache => new BrowserHistoryCache();
export const historyCache = new BrowserHistoryCache();

export const draftStorage = historyCache.drafts;
