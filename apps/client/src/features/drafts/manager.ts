import type {
  AccountCapture,
  AccountFence,
} from "@/client/features/cache/model";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { QuoteSelection } from "@/client/features/chat/quote-selection";
import { uploadTransport } from "@/client/features/files/transport";
import { DraftController } from "./controller";
import { claimDraft } from "./lock";
import {
  draftTargetKey,
  type DraftFence,
  type DraftPersistence,
  type DraftRecord,
  type DraftTarget,
} from "./model";

export interface DraftRoom {
  drafts: readonly DraftController[];
  active: DraftController;
  unavailable: boolean;
  elsewhere: boolean;
}
const sameOwner = (a: OwnerScope, b: OwnerScope) =>
  a.kind === b.kind && a.id === b.id;

/** One account's draft lifetimes; route components only attach views. */
export class DraftManager {
  private rooms = new Map<string, DraftRoom>();
  private loading = new Map<string, Promise<DraftRoom>>();
  private listeners = new Set<() => void>();
  private releases = new Map<DraftController, () => void>();
  private fences = new Map<string, DraftFence | null>();
  private retired = new Map<string, number>();
  private active = true;
  private online = false;
  private account: AccountFence | null = null;
  private mounts = 0;
  private dirtyRooms = new Set<string>();
  constructor(
    readonly userId: string,
    private storage: DraftPersistence,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  room = (target: DraftTarget) => this.rooms.get(draftTargetKey(target));
  hasDraft = (target: Pick<DraftTarget, "owner" | "channelId">) =>
    this.dirtyRooms.has(draftTargetKey(target));
  private changed(key: string) {
    const room = this.rooms.get(key);
    const dirty =
      room?.elsewhere ||
      (room?.drafts.some((draft) => draft.hasWork()) ?? false);
    const before = this.dirtyRooms.has(key);
    if (dirty) this.dirtyRooms.add(key);
    else this.dirtyRooms.delete(key);
    if (before !== dirty) this.publish();
  }
  matchesAccount(capture: AccountCapture) {
    return (
      this.account?.accountId === capture.accountId &&
      this.account?.accountEpoch === capture.accountEpoch &&
      this.account?.cacheId === capture.cacheId
    );
  }
  setAccess(account: AccountFence | null, online: boolean) {
    if (this.account && account && !this.matchesAccount(account)) {
      for (const draft of this.releases.keys()) this.release(draft);
      this.rooms.clear();
      this.dirtyRooms.clear();
      this.fences.clear();
      this.publish();
    }
    if (account) {
      const changed = !this.account || !this.matchesAccount(account);
      this.account = account;
      if (changed)
        void this.storage.targets(account).then((result) => {
          if (
            !this.active ||
            !this.matchesAccount(account) ||
            result.kind !== "ok"
          )
            return;
          for (const target of result.value) {
            const key = draftTargetKey(target);
            if (!this.rooms.has(key)) this.dirtyRooms.add(key);
          }
          this.publish();
        });
    }
    this.online = online;
    for (const room of this.rooms.values())
      for (const draft of room.drafts) draft.setOnline(online);
  }
  private make(
    record: DraftRecord,
    files: Map<string, File>,
    fence: DraftFence | null,
    release: () => void,
  ) {
    const key = draftTargetKey(record.target);
    const controller = new DraftController(
      record,
      files,
      uploadTransport(record.target.owner, record.target.channelId),
      {
        persistent: fence !== null,
        save: async (record, files) => {
          if (!fence) return false;
          const result = await this.storage.save(fence, record, files);
          if (result.kind === "stale") this.retire(fence.owner, false);
          return result.kind === "ok";
        },
        remove: async (id) => {
          if (!fence) return true;
          const result = await this.storage.remove(fence, id);
          if (result.kind === "stale") this.retire(fence.owner, false);
          return result.kind === "ok";
        },
        changed: () => this.changed(key),
        finished: () => this.finished(key, controller),
      },
    );
    this.releases.set(controller, release);
    controller.setOnline(this.online);
    return controller;
  }
  private blank(target: DraftTarget): DraftRecord {
    return {
      id: crypto.randomUUID(),
      target,
      selectedAt: Date.now(),
      text: { body: "", mentions: [] },
      quote: null,
      files: [],
      attempt: null,
    };
  }
  async open(target: DraftTarget): Promise<DraftRoom> {
    const key = draftTargetKey(target);
    const existing = this.rooms.get(key);
    if (existing) return existing;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const ownerKey = JSON.stringify(target.owner);
    const epoch = this.retired.get(ownerKey) ?? 0;
    const account = this.account;
    const current = () =>
      this.active &&
      (!account || this.matchesAccount(account)) &&
      epoch === (this.retired.get(ownerKey) ?? 0);
    const opening = (async () => {
      let fence: DraftFence | null = null;
      const drafts: DraftController[] = [];
      let unavailable = !this.account;
      let elsewhere = false;
      try {
        if (this.account) {
          const loaded = await this.storage.load(this.account, target);
          unavailable = loaded.kind !== "ok";
          if (loaded.kind === "ok") {
            fence = loaded.value.fence;
            for (const record of loaded.value.records) {
              const release =
                this.fences.get(key) === null
                  ? () => {}
                  : await claimDraft(this.userId, record.id);
              if (!release) {
                elsewhere = true;
                continue;
              }
              if (!current()) {
                release();
                break;
              }
              const restored = await this.storage.restore(fence, record.id);
              if (restored.kind !== "ok") {
                unavailable = restored.kind !== "miss";
                release();
                continue;
              }
              try {
                drafts.push(
                  this.make(
                    restored.value.record,
                    restored.value.files,
                    fence,
                    release,
                  ),
                );
              } catch {
                unavailable = true;
                release();
              }
            }
          }
        }
      } catch {
        fence = null;
        unavailable = true;
      }
      if (!current()) {
        for (const draft of drafts) this.release(draft);
        throw new Error("Draft account or conversation retired.");
      }
      if (!drafts.length) {
        const record = this.blank(target);
        let release = () => {};
        try {
          release = (await claimDraft(this.userId, record.id)) ?? release;
        } catch {
          fence = null;
          unavailable = true;
        }
        drafts.push(this.make(record, new Map(), fence, release));
      }
      if (!current()) {
        for (const draft of drafts) this.release(draft);
        throw new Error("Draft lifetime retired.");
      }
      this.fences.set(key, fence);
      const room = { drafts, active: drafts[0]!, unavailable, elsewhere };
      this.rooms.set(key, room);
      this.changed(key);
      this.publish();
      return room;
    })();
    this.loading.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.loading.get(key) === opening) this.loading.delete(key);
    }
  }
  async forward(target: DraftTarget, quote: QuoteSelection) {
    const room = await this.open(target);
    if (!this.active) return false;
    const key = draftTargetKey(target);
    let draft = room.active;
    if (draft.hasWork()) {
      const record = this.blank(target);
      const release =
        this.fences.get(key) === null
          ? () => {}
          : await claimDraft(this.userId, record.id);
      if (!this.active || this.rooms.get(key) !== room) {
        release?.();
        return false;
      }
      draft = this.make(
        record,
        new Map(),
        this.fences.get(key) ?? null,
        release ?? (() => {}),
      );
      this.rooms.set(key, {
        ...room,
        active: draft,
        drafts: [draft, ...room.drafts],
      });
    }
    draft.setQuote(quote);
    await draft.flush();
    if (!this.active || this.rooms.get(key)?.active !== draft) return false;
    this.publish();
    return true;
  }
  async reply(target: DraftTarget, quote: QuoteSelection) {
    const room = await this.open(target);
    if (room.active.getSnapshot().record.attempt)
      await this.forward(target, quote);
    else room.active.setQuote(quote);
  }
  select(target: DraftTarget, draft: DraftController) {
    const key = draftTargetKey(target);
    const room = this.rooms.get(key);
    if (!room?.drafts.includes(draft)) return;
    this.rooms.set(key, { ...room, active: draft });
    draft.select();
    this.publish();
    // Clearing the input keeps it empty while editing. Drop that empty draft
    // only after switching away, so an older draft never replaces typed input.
    if (room.active !== draft && !room.active.hasWork())
      void room.active.discard();
  }
  private finished(key: string, draft: DraftController) {
    const room = this.rooms.get(key);
    if (!room?.drafts.includes(draft)) return;
    const drafts = room.drafts.filter((item) => item !== draft);
    this.release(draft);
    if (!drafts.length) {
      const record = this.blank(draft.getSnapshot().record.target);
      drafts.push(
        this.make(record, new Map(), this.fences.get(key) ?? null, () => {}),
      );
      // New IDs cannot be restored in another tab before their first saved write.
      void claimDraft(this.userId, record.id)
        .then((release) => {
          if (release && this.releases.has(drafts[0]!))
            this.releases.set(drafts[0]!, release);
          else release?.();
        })
        .catch(() => {});
    }
    this.rooms.set(key, {
      ...room,
      drafts,
      active: room.active === draft ? drafts[0]! : room.active,
    });
    this.changed(key);
    this.publish();
  }
  private release(draft: DraftController) {
    draft.dispose();
    this.releases.get(draft)?.();
    this.releases.delete(draft);
  }
  retire(owner: OwnerScope, persist = true) {
    this.clearPreviews(owner);
    const ownerKey = JSON.stringify(owner);
    this.retired.set(ownerKey, (this.retired.get(ownerKey) ?? 0) + 1);
    for (const [key, room] of this.rooms) {
      if (sameOwner(room.active.getSnapshot().record.target.owner, owner)) {
        for (const draft of room.drafts) this.release(draft);
        this.rooms.delete(key);
        this.dirtyRooms.delete(key);
        this.fences.delete(key);
      }
    }
    for (const key of this.dirtyRooms) {
      const [kind, id] = JSON.parse(key) as string[];
      if (kind === owner.kind && id === owner.id) this.dirtyRooms.delete(key);
    }
    if (persist && this.account) void this.storage.retire(this.account, owner);
    this.publish();
  }
  clearPreviews(owner: OwnerScope) {
    for (const room of this.rooms.values())
      for (const draft of room.drafts) {
        const quote = draft.getSnapshot().record.quote;
        if (quote && sameOwner(quote.owner, owner)) draft.clearPreview();
      }
  }
  flush = () =>
    Promise.all(
      [...this.rooms.values()].flatMap((room) =>
        room.drafts.map((draft) => draft.flush()),
      ),
    );
  needsUnloadWarning = () =>
    [...this.rooms.values()].some((room) =>
      room.drafts.some((draft) => draft.needsUnloadWarning()),
    );
  attach() {
    this.mounts++;
    return () => {
      this.mounts--;
      queueMicrotask(() => {
        if (!this.mounts) this.dispose();
      });
    };
  }
  dispose() {
    this.active = false;
    for (const draft of this.releases.keys()) this.release(draft);
    this.rooms.clear();
    this.listeners.clear();
  }
}
