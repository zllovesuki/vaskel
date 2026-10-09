import { type RequestAccess } from "@/client/api/client";
import type { IdentityProfile } from "@vaskel/contracts/identity";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { AccountPreferences } from "@vaskel/contracts/preferences";
import { type UiMessage } from "@/client/features/i18n/messages";
import type {
  AccountCapture,
  AccountFence,
  CacheInvalidation,
} from "@/client/features/cache/model";
import type { AccessState, AccessDependencies } from "./model";
import {
  ApiError,
  errorMessage,
  instance,
  isCancellation,
  isNetworkError,
} from "@/client/api/client";

import { mergePreferences } from "@/client/features/account/preferences";
import { message } from "@/client/features/i18n/messages";

import { privateRequest, localFailure, requestOwner } from "./request-policy";

const VALIDITY_WINDOW = 30_000;
const PROFILE_WINDOW = 5 * 60_000;

const ownerKey = (owner: OwnerScope) => `${owner.kind}:${owner.id}`;

/** One document's interaction gate. Query and the owning actors keep server state. */
export class AccessCoordinator {
  private state: AccessState = {
    mode: "checking",
    canUseNetwork: false,
    user: null,
    cachedAccount: null,
    accountFence: null,
    cacheAvailable: true,
    attempt: 0,
    crossSearchEpoch: 0,
    deniedOwners: [],
    invalidatedOwners: [],
    error: null,
  };
  private listeners = new Set<() => void>();
  private active = false;
  private lifetime = 0;
  private identityRequest: AbortController | null = null;
  private sessionCheck: Promise<void> | null = null;
  private queuedCheck: Promise<void> | null = null;
  private capturedAccount: AccountCapture | null = null;
  private cacheDisabled = false;
  private cacheReadRevision = 0;
  private ownerEpochs = new Map<string, number>();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private validityDeadline = 0;
  private profileDeadline = 0;
  private visible = true;
  private foregroundElapsed = 0;
  private foregroundStartedAt = Date.now();

  constructor(private readonly dependencies: AccessDependencies) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(update: Partial<AccessState>) {
    this.state = { ...this.state, ...update };
    this.state.canUseNetwork = this.state.mode === "online";
    this.scheduleFreshness();
    for (const listener of this.listeners) listener();
  }
  private current(lifetime: number, attempt = this.state.attempt) {
    return (
      this.active &&
      lifetime === this.lifetime &&
      attempt === this.state.attempt
    );
  }
  private unavailableCache() {
    this.cacheDisabled = true;
    this.update({
      cacheAvailable: false,
      cachedAccount: null,
      accountFence: null,
    });
  }

  start(online: boolean, visible = true) {
    this.active = true;
    this.setVisible(visible);
    if (online) void this.retry();
    else this.disconnected();
  }
  stop() {
    this.active = false;
    this.clearDeadline();
    this.lifetime += 1;
    this.identityRequest?.abort();
    this.identityRequest = null;
    // Effect disposal is not logout and never changes persistent eligibility.
  }

  private foregroundTime(now = Date.now()) {
    return (
      this.foregroundElapsed +
      (this.visible ? now - this.foregroundStartedAt : 0)
    );
  }
  setVisible = (visible: boolean) => {
    this.foregroundElapsed = this.foregroundTime();
    this.foregroundStartedAt = Date.now();
    this.visible = visible;
    this.scheduleFreshness();
  };
  private clearDeadline() {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
  private scheduleFreshness() {
    this.clearDeadline();
    if (!this.active || !this.state.canUseNetwork || this.sessionCheck) return;
    const wait = Math.min(
      this.validityDeadline - Date.now(),
      this.visible ? this.profileDeadline - this.foregroundTime() : Infinity,
    );
    this.deadlineTimer = setTimeout(
      () => {
        this.deadlineTimer = null;
        // Maintenance never queues behind a forced read or consumes its follow-up.
        if (this.active && this.state.canUseNetwork && !this.sessionCheck)
          void this.runSessionCheck();
      },
      Math.max(0, wait),
    );
  }
  private identityAccepted(startedAt: number, foregroundStarted: number) {
    this.validityDeadline = Math.max(
      this.validityDeadline,
      startedAt + VALIDITY_WINDOW,
    );
    this.profileDeadline = Math.max(
      this.profileDeadline,
      foregroundStarted + PROFILE_WINDOW,
    );
    this.scheduleFreshness();
  }

  /**
   * A check already in flight may have read identity before the caller's own
   * change reached vaskel., so a concurrent request is queued behind it instead of
   * dropped, and the caller waits for that follow-up rather than for the
   * earlier answer.
   */
  checkSession = (): Promise<void> => {
    if (!this.active || !this.state.canUseNetwork) return Promise.resolve();
    if (!this.sessionCheck) return this.runSessionCheck();
    this.queuedCheck ??= this.sessionCheck.then(() => {
      // The follow-up re-reads the gate: a check nobody can make is not owed.
      this.queuedCheck = null;
      return this.checkSession();
    });
    return this.queuedCheck;
  };
  private runSessionCheck() {
    this.clearDeadline();
    const running = this.readSession().finally(() => {
      if (this.sessionCheck === running) {
        this.sessionCheck = null;
        this.scheduleFreshness();
      }
    });
    this.sessionCheck = running;
    return running;
  }
  private async readSession() {
    const lifetime = this.lifetime;
    const attempt = this.state.attempt;
    const controller = new AbortController();
    try {
      const capture = await this.dependencies.cache.captureAccount();
      if (!this.current(lifetime, attempt)) return;
      if (capture.kind === "unavailable") this.unavailableCache();
      const startedAt = Date.now();
      const foregroundStarted = this.foregroundTime(startedAt);
      const identity = await this.dependencies.identity(controller.signal);
      if (!this.current(lifetime, attempt)) return;
      if (identity.status === "authenticated" && "user" in identity) {
        if (identity.user.userId !== this.state.user?.userId) {
          await this.switchAccount();
        } else {
          this.identityAccepted(startedAt, foregroundStarted);
          this.acceptProfile(identity.user);
        }
      } else if (["unauthenticated", "forbidden"].includes(identity.status)) {
        await this.logout(message("api.unauthenticated"));
      } else this.identityFailed(new ApiError(identity.status), attempt);
    } catch (error) {
      if (this.current(lifetime, attempt) && !isCancellation(error))
        this.identityFailed(error, attempt);
    }
  }

  readonly transport: RequestAccess = {
    begin: (_path, init, scope) => {
      const state = this.state;
      if (privateRequest(scope) && !state.canUseNetwork)
        throw new ApiError("offline", undefined, "blocked");
      const lifetime = this.lifetime;
      const attempt = state.attempt;
      const searchEpoch = state.crossSearchEpoch;
      const crossSearch = scope.freshness === "search";
      const owner = requestOwner(scope);
      const key = owner ? ownerKey(owner) : null;
      const ownerEpoch = key ? (this.ownerEpochs.get(key) ?? 0) : 0;
      // Sign-out and explicit media cleanup must finish after local teardown.
      if (scope.authority === "cleanup")
        return {
          current: () => !init.signal?.aborted,
          accountId: null,
        };
      return {
        current: () =>
          this.current(lifetime, attempt) &&
          (!crossSearch || this.state.crossSearchEpoch === searchEpoch) &&
          (!key || (this.ownerEpochs.get(key) ?? 0) === ownerEpoch),
        accountId: privateRequest(scope) ? (state.user?.userId ?? null) : null,
      };
    },
    succeeded: (_path, startedAt, request, scope) => {
      if (
        !privateRequest(scope) ||
        !request.accountId ||
        request.accountId !== this.state.user?.userId ||
        !request.current()
      )
        return;
      this.validityDeadline = Math.max(
        this.validityDeadline,
        startedAt + VALIDITY_WINDOW,
      );
      this.scheduleFreshness();
    },
    failed: (_path, error, scope) => {
      if (
        !this.active ||
        (!privateRequest(scope) && scope.authority !== "identity")
      )
        return;
      if (localFailure(scope, error)) {
        return;
      } else if (error.status === 401 || error.code === "unauthenticated") {
        void this.logout(
          scope.authority === "identity"
            ? this.sessionEndedMessage()
            : errorMessage(error),
        );
      } else if (
        error.status === 403 ||
        ["forbidden", "not_found"].includes(error.code)
      ) {
        const owner = requestOwner(scope);
        if (owner) void this.denyOwner(owner, error.code);
        else void this.logout(errorMessage(error));
      } else if (scope.authority === "identity" && isNetworkError(error))
        this.disconnected();
    },
  };

  private sessionEndedMessage() {
    return this.state.user ||
      this.state.cachedAccount ||
      this.capturedAccount?.accountId
      ? message("api.unauthenticated")
      : null;
  }

  retry = async () => {
    if (!this.active) return;
    this.identityRequest?.abort();
    const controller = new AbortController();
    this.identityRequest = controller;
    const lifetime = this.lifetime;
    const attempt = this.state.attempt + 1;
    this.update({
      mode: "reconnecting",
      attempt,
      error: null,
    });
    this.invalidateCrossSearch();
    this.dependencies.stopPrivateWork();
    try {
      // A durable capture precedes the network result that may activate it.
      const capture = await this.dependencies.cache.captureAccount();
      if (!this.current(lifetime, attempt)) return;
      this.capturedAccount = capture.kind === "ok" ? capture.value : null;
      if (capture.kind === "unavailable") this.unavailableCache();
      const startedAt = Date.now();
      const foregroundStarted = this.foregroundTime(startedAt);
      const identity = await this.dependencies.identity(controller.signal);
      if (!this.current(lifetime, attempt)) return;
      if (identity.status !== "authenticated" || !("user" in identity)) {
        if (["unauthenticated", "forbidden"].includes(identity.status))
          await this.logout(
            identity.status === "unauthenticated"
              ? this.sessionEndedMessage()
              : errorMessage(new ApiError(identity.status)),
          );
        else this.identityFailed(new ApiError(identity.status), attempt);
        return;
      }
      const previousAccount =
        this.state.user?.userId ??
        this.state.cachedAccount?.accountId ??
        this.capturedAccount?.accountId;
      if (previousAccount && previousAccount !== identity.user.userId) {
        await this.switchAccount();
        return;
      }
      let accountFence: AccountFence | null = null;
      if (capture.kind === "ok" && !this.cacheDisabled) {
        const activated = await this.dependencies.cache.activateAccount(
          capture.value,
          {
            accountId: identity.user.userId,
            label: identity.user.displayName,
          },
        );
        if (!this.current(lifetime, attempt)) return;
        if (activated.kind === "stale" || activated.kind === "miss") {
          this.closeLocally(message("access.localChanged"));
          return;
        }
        if (activated.kind === "ok") accountFence = activated.value;
        else this.unavailableCache();
      }
      this.identityAccepted(startedAt, foregroundStarted);
      this.update({
        user: this.profileWithPreferences(identity.user),
        accountFence,
        cachedAccount: null,
        mode: "online",
        deniedOwners: [],
        invalidatedOwners: [],
      });
      this.rememberPreferences();
    } catch (error) {
      if (this.current(lifetime, attempt) && !isCancellation(error))
        this.identityFailed(error, attempt);
    }
  };

  private profileWithPreferences(incoming: IdentityProfile): IdentityProfile {
    const current = this.state.user;
    return current?.userId === incoming.userId
      ? {
          ...incoming,
          preferences: mergePreferences(
            current.preferences,
            incoming.preferences,
          ),
        }
      : incoming;
  }
  private acceptProfile(incoming: IdentityProfile) {
    // Fresh identity fields still apply even when its preference revision is older.
    this.update({ user: this.profileWithPreferences(incoming) });
    this.rememberPreferences();
  }
  preferenceToken = (accountId: string) =>
    this.active && this.state.user?.userId === accountId
      ? JSON.stringify([this.lifetime, this.state.user.userId])
      : null;
  acceptPreferences = (
    token: string,
    incoming: AccountPreferences,
  ): boolean => {
    const user = this.state.user;
    if (!user || token !== this.preferenceToken(user.userId)) return false;
    const preferences = mergePreferences(user.preferences, incoming);
    if (preferences !== user.preferences)
      this.update({ user: { ...user, preferences } });
    this.rememberPreferences();
    return true;
  };
  private rememberPreferences() {
    const fence = this.state.accountFence;
    const preferences = this.state.user?.preferences;
    if (!fence || !preferences?.language || this.cacheDisabled) return;
    const lifetime = this.lifetime;
    void this.dependencies.cache
      .saveDisplayLanguage(fence, preferences)
      .then((result) => {
        if (!this.current(lifetime) || this.state.accountFence !== fence)
          return;
        if (result.kind === "unavailable") this.unavailableCache();
      });
  }

  private identityFailed = (error: unknown, attempt = this.state.attempt) => {
    if (!this.active || attempt !== this.state.attempt || isCancellation(error))
      return;
    if (isNetworkError(error)) this.disconnected();
    else
      this.update({
        mode: "reconnecting",
        cachedAccount: null,
        error: errorMessage(error),
      });
  };

  disconnected = () => {
    if (!this.active || this.state.mode === "signed-out") return;
    this.identityRequest?.abort();
    this.update({
      mode: this.state.user ? "live-disconnected" : "cached",
      attempt: this.state.attempt + 1,
      error: null,
    });
    this.invalidateCrossSearch();
    this.dependencies.stopPrivateWork();
    if (!this.state.user) void this.readCached();
  };
  private async readCached() {
    if (this.cacheDisabled) return;
    const lifetime = this.lifetime;
    const attempt = this.state.attempt;
    const revision = this.cacheReadRevision;
    const current = () =>
      this.current(lifetime, attempt) && revision === this.cacheReadRevision;
    const cached = await this.dependencies.cache.readAccount();
    if (!current() || this.state.mode !== "cached") return;
    if (cached.kind === "unavailable") {
      this.unavailableCache();
      return;
    }
    if (cached.kind !== "ok") {
      this.update({ cachedAccount: null });
      return;
    }
    // A held IDB read may finish after a remote purge whose broadcast was missed.
    const account = await this.dependencies.cache.recheck(cached.value.fence);
    if (!current()) return;
    if (account.kind !== "ok") {
      if (account.kind === "unavailable") this.unavailableCache();
      else this.closeLocally(message("access.remoteChanged"));
      return;
    }
    const snapshots = [];
    for (const snapshot of cached.value.snapshots) {
      const scope = await this.dependencies.cache.recheck(snapshot.fence);
      if (!current()) return;
      if (scope.kind === "unavailable") {
        this.unavailableCache();
        return;
      }
      if (scope.kind === "ok") snapshots.push(snapshot);
    }
    this.update({ cachedAccount: { ...cached.value, snapshots } });
  }
  private closeLocally(error: UiMessage | null) {
    this.validityDeadline = 0;
    this.profileDeadline = 0;
    this.lifetime += 1;
    this.ownerEpochs.clear();
    this.identityRequest?.abort();
    this.update({
      mode: "signed-out",
      attempt: this.state.attempt + 1,
      user: null,
      cachedAccount: null,
      accountFence: null,
      deniedOwners: [],
      invalidatedOwners: [],
      error,
    });
    this.dependencies.closeAccount();
  }
  logout = async (notice: UiMessage | null = null) => {
    const fence =
      this.state.accountFence ??
      this.state.cachedAccount?.fence ??
      this.capturedAccount;
    this.closeLocally(notice);
    this.capturedAccount = null;
    const result = fence
      ? await this.dependencies.cache.invalidateAccount(fence)
      : await this.dependencies.cache.clear();
    if (result.kind === "unavailable") {
      this.unavailableCache();
      this.update({
        error: message("access.signedOutRemovalFailed"),
      });
    }
  };
  private async switchAccount() {
    // Verified replacement retires the previous account even if the next
    // request cannot reach vaskel. Never reopen that old remembered account.
    const removal = this.logout();
    const lifetime = this.lifetime;
    await removal;
    if (this.current(lifetime)) void this.retry();
  }
  signOutFailed = (_error: unknown) => {
    if (this.state.mode === "signed-out")
      this.update({
        error: message("access.signOutFailed"),
      });
  };
  removeCached = async () => {
    const lifetime = this.lifetime;
    this.update({
      cachedAccount: null,
      error: null,
      ...(!this.state.user
        ? {
            mode: "cached" as const,
            attempt: this.state.attempt + 1,
          }
        : {}),
    });
    const result = await this.dependencies.cache.clearHistory();
    if (!this.current(lifetime)) return;
    if (result.kind === "unavailable") {
      this.unavailableCache();
      this.update({
        error: message("access.removalFailed"),
      });
    }
  };
  /**
   * A denial a timeline decoded itself or received on its room socket. An HTTP
   * denial already reached `transport.failed`, so it is not reported twice;
   * the caller still closes its local view on it.
   */
  ownerDenied = (owner: OwnerScope, error: ApiError) =>
    error.failure === "http"
      ? Promise.resolve()
      : this.denyOwner(owner, error.code);
  /** The one purge of a denied owner: Query through the dependency, then durable history. */
  private denyOwner = async (owner: OwnerScope, code: string) => {
    if (code === "unauthenticated")
      return this.logout(message("api.unauthenticated"));
    this.invalidateOwnerSearch(owner);
    const key = ownerKey(owner);
    this.ownerEpochs.set(key, (this.ownerEpochs.get(key) ?? 0) + 1);
    const fence = this.state.accountFence;
    const lifetime = this.lifetime;
    const attempt = this.state.attempt;
    this.update({
      deniedOwners: [...new Set([...this.state.deniedOwners, key])],
      cachedAccount: this.withoutCachedOwner(owner),
    });
    this.dependencies.invalidateOwner(
      owner,
      this.state.user?.userId ?? null,
      true,
    );
    if (fence) {
      const scope = await this.dependencies.cache.captureScope(fence, owner);
      if (!this.current(lifetime, attempt)) return;
      if (scope.kind === "ok") {
        const result = await this.dependencies.cache.invalidateOwner(
          scope.value,
        );
        if (!this.current(lifetime, attempt)) return;
        if (result.kind === "unavailable") this.unavailableCache();
      } else if (scope.kind === "unavailable") this.unavailableCache();
    }
  };
  private withoutCachedOwner(owner: OwnerScope) {
    const cached = this.state.cachedAccount;
    return cached
      ? {
          ...cached,
          snapshots: cached.snapshots.filter(
            (snapshot) => ownerKey(snapshot.fence.owner) !== ownerKey(owner),
          ),
        }
      : null;
  }
  /**
   * Retire durable history without replacing a resident timeline. Search copies
   * survive ordinary mutations; directory/access hints additionally retire this owner's hits.
   */
  invalidateOwnerContent = async (owner: OwnerScope, accessChanged = false) => {
    if (!this.active || !this.state.user) return;
    if (accessChanged) this.invalidateOwnerSearch(owner);
    this.update({ cachedAccount: this.withoutCachedOwner(owner) });
    const fence = this.state.accountFence;
    if (!fence) return;
    const lifetime = this.lifetime;
    // Disconnection does not undo knowledge received while online. Account
    // replacement does: never retire a new account's scope with an old hint.
    const current = () =>
      this.current(lifetime) && this.state.accountFence === fence;
    try {
      const capture = await this.dependencies.cache.captureScope(fence, owner);
      if (!current()) return;
      if (capture.kind === "unavailable") this.unavailableCache();
      else if (capture.kind === "ok") {
        const retired = await this.dependencies.cache.invalidateOwner(
          capture.value,
        );
        if (current() && retired.kind === "unavailable")
          this.unavailableCache();
      }
    } catch {
      if (current()) this.unavailableCache();
    }
  };
  invalidateOwnerView = (owner: OwnerScope) => {
    this.invalidateOwnerSearch(owner);
    const key = ownerKey(owner);
    this.ownerEpochs.set(key, (this.ownerEpochs.get(key) ?? 0) + 1);
    this.update({
      invalidatedOwners: [...new Set([...this.state.invalidatedOwners, key])],
    });
    this.dependencies.invalidateOwner(
      owner,
      this.state.user?.userId ?? null,
      false,
    );
  };
  /** Async account work must recheck this before creating a new resource. */
  accountToken = () =>
    JSON.stringify([
      this.lifetime,
      this.state.attempt,
      this.state.user?.userId,
    ]);
  accountCurrent = (token: string) =>
    this.active &&
    this.state.canUseNetwork &&
    Boolean(this.state.user) &&
    token === this.accountToken();
  crossSearchToken = () =>
    JSON.stringify([
      this.lifetime,
      this.state.attempt,
      this.state.crossSearchEpoch,
    ]);
  crossSearchCurrent = (token: string) =>
    this.active &&
    Boolean(this.state.user) &&
    this.state.canUseNetwork &&
    token === this.crossSearchToken();
  private invalidateOwnerSearch(owner: OwnerScope) {
    const accountId = this.state.user?.userId;
    if (accountId) this.dependencies.invalidateCrossSearch(accountId, owner);
  }
  invalidateCrossSearch = () => {
    this.update({ crossSearchEpoch: this.state.crossSearchEpoch + 1 });
    const accountId = this.state.user?.userId;
    if (accountId) this.dependencies.invalidateCrossSearch(accountId);
  };
  ownerToken = (owner: OwnerScope) =>
    JSON.stringify([
      this.lifetime,
      this.state.attempt,
      owner.kind,
      owner.id,
      this.ownerEpochs.get(ownerKey(owner)) ?? 0,
    ]);
  ownerReady = (owner: OwnerScope, token: string) => {
    // Query acceptance can happen after HTTP decoding and after invalidation.
    // A passive React effect must still belong to the producing owner request.
    if (!this.active || !this.state.user || token !== this.ownerToken(owner))
      return false;
    const key = ownerKey(owner);
    if (
      this.state.invalidatedOwners.includes(key) ||
      this.state.deniedOwners.includes(key)
    )
      this.update({
        invalidatedOwners: this.state.invalidatedOwners.filter(
          (entry) => entry !== key,
        ),
        deniedOwners: this.state.deniedOwners.filter((entry) => entry !== key),
      });
    return true;
  };
  cacheChanged = (event: CacheInvalidation, source: "local" | "remote") => {
    if (event.origin !== instance || event.type === "drafts_retired") return;
    this.cacheReadRevision += 1;
    const fence = this.state.accountFence ?? this.state.cachedAccount?.fence;
    if (event.type === "cache") {
      this.unavailableCache();
      return;
    }
    if (!fence) {
      if (this.state.mode === "cached") {
        if (event.type === "account" && source === "remote")
          this.closeLocally(message("access.remoteChanged"));
        else void this.readCached();
      }
      return;
    }
    if (
      event.cacheId !== fence.cacheId ||
      event.accountEpoch !== fence.accountEpoch ||
      event.accountId !== fence.accountId
    )
      return;
    if (event.type === "account") {
      if (source === "remote")
        this.closeLocally(message("access.remoteChanged"));
    } else {
      this.update({ cachedAccount: this.withoutCachedOwner(event.owner) });
      if (source === "remote" && event.type === "owner")
        this.invalidateOwnerView(event.owner);
      if (this.state.mode === "cached") void this.readCached();
    }
  };
  recheck = async () => {
    const fence = this.state.accountFence ?? this.state.cachedAccount?.fence;
    if (!fence || this.cacheDisabled) return;
    const lifetime = this.lifetime;
    const result = await this.dependencies.cache.recheck(fence);
    if (!this.current(lifetime)) return;
    if (result.kind === "stale" || result.kind === "miss")
      this.closeLocally(message("access.remoteChanged"));
    else if (result.kind === "unavailable") this.unavailableCache();
    else if (this.state.mode === "cached") await this.readCached();
  };
}
