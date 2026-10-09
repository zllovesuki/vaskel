export type UnfinishedWorkState = "draft" | "sending" | "uncertain" | null;

interface Entry {
  state: UnfinishedWorkState;
}

export interface UnfinishedWorkRegistration {
  update: (state: UnfinishedWorkState) => void;
  release: () => void;
}

/** Protects the current conversation's aggregate work; saved drafts outlive navigation. */
export class UnfinishedWorkGuard {
  private current: Entry | null = null;
  private listeners = new Set<() => void>();
  private confirmation: UnfinishedWorkState = null;
  private pending: {
    resolve: (allow: boolean) => void;
  } | null = null;

  getSnapshot = () => this.confirmation;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  hasWork = () => this.current !== null && this.current.state !== null;

  register(): UnfinishedWorkRegistration {
    this.retire();
    const entry: Entry = { state: null };
    this.current = entry;
    return {
      update: (state) => {
        if (this.current !== entry || entry.state === state) return;
        entry.state = state;
        this.refreshConfirmation();
      },
      release: () => {
        if (this.current === entry) this.retire();
      },
    };
  }

  blockNavigation = (
    currentPath: string,
    nextPath: string,
  ): Promise<boolean> => {
    // Query/hash changes preserve the keyed conversation and its message edits.
    if (currentPath.replace(/\/+$/, "") === nextPath.replace(/\/+$/, ""))
      return Promise.resolve(false);
    return this.confirm().then((allow) => !allow);
  };

  keep = () => this.settle(false);
  abandon = () => this.settle(true);

  retire = () => {
    // Never navigate on behalf of a retired conversation or account.
    this.current = null;
    this.settle(false);
  };

  private confirm(): Promise<boolean> {
    // Repeated Back/link actions cannot replace the decision already shown.
    if (this.pending) return Promise.resolve(false);
    if (!this.hasWork()) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.refreshConfirmation();
    });
  }

  private refreshConfirmation() {
    if (!this.pending) return;
    const state = this.current?.state ?? null;
    if (state === null) {
      // The mutation was accepted, or the user removed the unfinished work.
      this.settle(true);
      return;
    }
    if (this.confirmation === state) return;
    this.confirmation = state;
    this.publish();
  }

  private settle(allow: boolean) {
    const pending = this.pending;
    this.pending = null;
    this.confirmation = null;
    if (!pending) return;
    this.publish();
    pending.resolve(allow);
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
