import { failureResponse } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { QueryClient } from "@tanstack/react-query";
import { CrossSearchResponseSchema } from "@vaskel/contracts/search";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IdentityProfile } from "@vaskel/contracts/identity";
import type { AccessCoordinator as Coordinator } from "@/client/features/cache/access/coordinator";
import type { AccessDependencies } from "@/client/features/cache/access/model";
import { accessSnapshot } from "@/client/features/cache/access/presentation";
import {
  AccountFenceSchema,
  DisplayLanguageHintSchema,
  type AccountCapture,
  type AccountFence,
  type CachedAccount,
  type HistoryCache,
} from "@/client/features/cache/model";
import type { Access } from "@/client/features/cache/access/context";

let AccessCoordinator: typeof Coordinator;
let language: typeof import("@/client/features/i18n/provider");
let context: typeof import("@/client/features/cache/access/context");
let hooks: typeof import("@/client/features/i18n/use-i18n");
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  vi.stubGlobal("navigator", { languages: ["ko-KR", "zh-Hant-TW"] });
  ({ AccessCoordinator } =
    await import("@/client/features/cache/access/coordinator"));
  language = await import("@/client/features/i18n/provider");
  context = await import("@/client/features/cache/access/context");
  hooks = await import("@/client/features/i18n/use-i18n");
});
afterAll(() => vi.unstubAllGlobals());

const user: IdentityProfile = {
  userId: "00000000-0000-4000-8000-000000000001",
  displayName: "River",
  email: "river@example.test",
  isOperator: false,
  expiresAt: "2030-01-01T00:00:00.000Z",
  preferences: { language: null, revision: 0 },
};
const fence: AccountFence = {
  origin: "https://vaskel.test",
  cacheId: "00000000-0000-4000-8000-000000000002",
  accountEpoch: "00000000-0000-4000-8000-000000000003",
  accountId: user.userId,
};
const owner = { kind: "server" as const, id: "server-a" };
function ok<T>(value: T) {
  return { kind: "ok" as const, value };
}

function fixture() {
  let capture: AccountCapture = {
    ...fence,
    accountId: null,
  };
  const cache: HistoryCache = {
    captureAccount: vi.fn(async () => ok(capture)),
    activateAccount: vi.fn(async (_previous, account) => {
      capture = {
        ...capture,
        accountId: account.accountId,
      };
      return ok({
        ...capture,
        accountId: account.accountId,
      });
    }),
    saveDisplayLanguage: vi.fn(async () => ok(undefined)),
    captureScope: vi.fn(async () => ({ kind: "miss" as const })),
    authorizeScope: vi.fn(async () => ({ kind: "miss" as const })),
    save: vi.fn(async () => ({ kind: "miss" as const })),
    readAccount: vi.fn(async () => ({ kind: "miss" as const })),
    readSnapshot: vi.fn(async () => ({ kind: "miss" as const })),
    recheck: vi.fn(async () => ok(undefined)),
    invalidateAccount: vi.fn(async () => {
      capture = {
        ...capture,
        accountEpoch: crypto.randomUUID(),
        accountId: null,
      };
      return ok(undefined);
    }),
    invalidateOwner: vi.fn(async () => ok(undefined)),
    clear: vi.fn(async () => ok(undefined)),
    clearHistory: vi.fn(async () => ok(undefined)),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(),
  };
  const identity = vi.fn<AccessDependencies["identity"]>(async () => ({
    status: "authenticated",
    user,
  }));
  const dependencies = {
    cache,
    identity,
    stopPrivateWork: vi.fn(),
    closeAccount: vi.fn(),
    invalidateOwner: vi.fn(),
    invalidateCrossSearch: vi.fn(),
  };
  const access = new AccessCoordinator(dependencies);
  return { access, cache, dependencies };
}
async function ready(access: Coordinator, start = true) {
  if (start) access.start(true);
  await vi.waitFor(() => expect(access.getSnapshot().mode).toBe("online"));
}
function renderLanguage(access: Coordinator) {
  const value: Access = {
    ...accessSnapshot(access.getSnapshot()),
    retry: access.retry,
    checkSession: access.checkSession,
    logout: access.logout,
    signOutFailed: access.signOutFailed,
    removeCached: access.removeCached,
    ownerDenied: access.ownerDenied,
    ownerReady: access.ownerReady,
    ownerToken: access.ownerToken,
    accountToken: access.accountToken,
    accountCurrent: access.accountCurrent,
    crossSearchToken: access.crossSearchToken,
    crossSearchCurrent: access.crossSearchCurrent,
    invalidateCrossSearch: access.invalidateCrossSearch,
    invalidateOwnerContent: access.invalidateOwnerContent,
    invalidateOwnerView: access.invalidateOwnerView,
    preferenceToken: access.preferenceToken,
    acceptPreferences: access.acceptPreferences,
  };
  function Probe() {
    const { language: selected, t } = hooks.useI18n();
    return createElement("span", { lang: selected }, t("account.language"));
  }
  return renderToStaticMarkup(
    createElement(
      context.AccessContext,
      { value },
      createElement(language.LanguageProvider, null, createElement(Probe)),
    ),
  );
}

describe("account language lifetimes", () => {
  it("uses browser presentation without saving a preference before sign-in or for an unset account", async () => {
    const { access, cache } = fixture();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(renderLanguage(access)).toContain('lang="zh-Hant"');
    await ready(access);
    await access.checkSession();
    expect(renderLanguage(access)).toContain('lang="zh-Hant"');
    expect(access.getSnapshot().user?.preferences).toEqual({
      language: null,
      revision: 0,
    });
    expect(cache.saveDisplayLanguage).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains a committed choice across a delayed older profile while applying fresh profile fields", async () => {
    const { access, cache, dependencies } = fixture();
    await ready(access);
    const originalToken = access.ownerToken(owner);
    const searchToken = access.crossSearchToken();
    const searchEpoch = access.getSnapshot().crossSearchEpoch;
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    const refresh = access.checkSession();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(2),
    );
    const stops = dependencies.stopPrivateWork.mock.calls.length;
    expect(
      access.acceptPreferences(access.preferenceToken(user.userId)!, {
        language: "ja",
        revision: 4,
      }),
    ).toBe(true);
    expect(access.ownerToken(owner)).toBe(originalToken);
    expect(access.crossSearchCurrent(searchToken)).toBe(true);
    expect(access.getSnapshot().crossSearchEpoch).toBe(searchEpoch);
    expect(dependencies.stopPrivateWork).toHaveBeenCalledTimes(stops);
    expect(access.getSnapshot()).toMatchObject({
      mode: "online",
    });
    held.resolve({
      status: "authenticated",
      user: {
        ...user,
        displayName: "Fresh name",
        expiresAt: "2031-01-01T00:00:00.000Z",
        preferences: { language: "en", revision: 2 },
      },
    });
    await refresh;
    expect(access.getSnapshot().user).toMatchObject({
      displayName: "Fresh name",
      expiresAt: "2031-01-01T00:00:00.000Z",
      preferences: { language: "ja", revision: 4 },
    });
    expect(cache.saveDisplayLanguage).toHaveBeenLastCalledWith(
      access.getSnapshot().accountFence,
      { language: "ja", revision: 4 },
    );
    expect(renderLanguage(access)).toContain('lang="ja"');
    expect(renderLanguage(access)).toContain("表示言語");
    dependencies.identity.mockResolvedValueOnce({
      status: "authenticated",
      user: {
        ...user,
        preferences: { language: "en", revision: 1 },
      },
    });
    await access.retry();
    expect(access.getSnapshot().user?.preferences).toEqual({
      language: "ja",
      revision: 4,
    });
  });

  it("retires the previous account and accepts the new account’s lower preference revision", async () => {
    const { access, cache, dependencies } = fixture();
    await ready(access);
    const token = access.preferenceToken(user.userId)!;
    access.acceptPreferences(token, { language: "ja", revision: 40 });
    const oldFence = access.getSnapshot().accountFence;
    const oldOwner = access.ownerToken(owner);
    const oldSearch = access.crossSearchToken();
    const pendingResponse = access.transport.begin(
      "/api/account/preferences",
      {},
      { authority: "account" },
    );
    const replacement = {
      ...user,
      userId: "00000000-0000-4000-8000-000000000098",
      preferences: { language: "en" as const, revision: 2 },
    };
    dependencies.identity.mockResolvedValue({
      status: "authenticated",
      user: replacement,
    });
    await access.checkSession();
    await ready(access, false);
    expect(cache.invalidateAccount).toHaveBeenCalledExactlyOnceWith(oldFence);
    expect(dependencies.closeAccount).toHaveBeenCalledOnce();
    expect(pendingResponse.current()).toBe(false);
    expect(access.crossSearchCurrent(oldSearch)).toBe(false);
    expect(access.ownerReady(owner, oldOwner)).toBe(false);
    expect(
      access.acceptPreferences(token, { language: "ja", revision: 41 }),
    ).toBe(false);
    expect(access.getSnapshot().user).toEqual(replacement);
    expect(access.getSnapshot().accountFence?.accountId).toBe(
      replacement.userId,
    );
    expect(cache.saveDisplayLanguage).toHaveBeenLastCalledWith(
      access.getSnapshot().accountFence,
      replacement.preferences,
    );
    expect(renderLanguage(access)).toContain('lang="en"');
  });

  it("an expired session removes private Query pages and fences their delayed HTTP result", async () => {
    const { access, cache, dependencies } = fixture();
    const api = await import("@/client/api/client");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    dependencies.closeAccount.mockImplementation(() => {
      void client.cancelQueries({ queryKey: ["private"] });
      client.removeQueries({ queryKey: ["private"] });
    });
    await ready(access);
    const held = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path.includes("search")
          ? held.promise
          : failureResponse({ kind: "unauthenticated" }, { status: 401 }),
      ),
    );
    const removeAccess = api.installRequestAccess(access.transport);
    const key = [...api.privateKey(user.userId), "cross-search"];
    client.setQueryData([...api.privateKey(user.userId), "timeline"], {
      privateBody: "old snapshot",
    });
    const pending = client
      .fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) =>
          api.requestWithInit(
            "/api/account/search",
            CrossSearchResponseSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: "hello" }),
              signal: signal,
            },
            {
              authority: "account",
              freshness: "search",
            },
          ),
      })
      .catch(() => null);
    const replacement = {
      ...user,
      userId: "00000000-0000-4000-8000-000000000098",
    };
    dependencies.identity.mockResolvedValue({
      status: "authenticated",
      user: replacement,
    });
    try {
      await expect(
        api.requestWithInit(
          "/api/resources/server/old/send",
          MessagingOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandId: crypto.randomUUID(),
            }),
          },
          {
            authority: "resource",
            owner: { kind: "server", id: "old" },
          },
        ),
      ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
      await access.retry();
      await ready(access, false);
      expect(cache.invalidateAccount).toHaveBeenCalledOnce();
      expect(
        client.getQueryCache().findAll({ queryKey: ["private"] }),
      ).toHaveLength(0);
      held.resolve(
        Response.json({
          kind: "cross_matches",
          hits: [],
          deniedServerIds: [],
          unavailableServerIds: [],
          coverage: { limited: false, unavailable: false },
          nextCursor: null,
        }),
      );
      await pending;
      expect(client.getQueryData(key)).toBeUndefined();
      expect(access.getSnapshot().user).toEqual(replacement);
    } finally {
      held.resolve(Response.json({}));
      removeAccess();
      client.clear();
    }
  });

  it("ignores a delayed profile when reconnect has confirmed a different account", async () => {
    const { access, dependencies } = fixture();
    await ready(access);
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    const oldRefresh = access.checkSession();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(2),
    );
    const replacement = {
      ...user,
      userId: "00000000-0000-4000-8000-000000000098",
      preferences: { language: "en" as const, revision: 1 },
    };
    dependencies.identity.mockResolvedValue({
      status: "authenticated",
      user: replacement,
    });
    await access.retry();
    await ready(access, false);
    held.resolve({
      status: "authenticated",
      user: { ...user, preferences: { language: "ja", revision: 100 } },
    });
    await oldRefresh;
    expect(access.getSnapshot().user).toEqual(replacement);
  });

  it("rejects history and language hints without an account epoch", async () => {
    const { access, cache } = fixture();
    const { accountEpoch: _accountEpoch, ...unmarkedFence } = fence;
    expect(AccountFenceSchema.safeParse(unmarkedFence).success).toBe(false);
    expect(
      DisplayLanguageHintSchema.safeParse({
        fence: unmarkedFence,
        language: "ja",
        revision: 40,
      }).success,
    ).toBe(false);
    // The adapter reports invalid stored records without presenting their data.
    vi.mocked(cache.readAccount).mockResolvedValueOnce({
      kind: "unavailable",
      reason: "corrupt",
    });
    access.start(false);
    await vi.waitFor(() =>
      expect(access.getSnapshot().cacheAvailable).toBe(false),
    );
    expect(access.getSnapshot().cachedAccount).toBeNull();
    expect(access.getSnapshot().user).toBeNull();
    expect(renderLanguage(access)).toContain('lang="zh-Hant"');
    await access.retry();
    await ready(access, false);
    expect(access.getSnapshot().user?.userId).toBe(user.userId);
    expect(cache.activateAccount).not.toHaveBeenCalled();
    expect(cache.invalidateAccount).not.toHaveBeenCalled();
  });

  it("accepts newer background preferences and ignores older or conflicting same-revision saves", async () => {
    const { access, dependencies } = fixture();
    await ready(access);
    const token = access.preferenceToken(user.userId)!;
    access.acceptPreferences(token, { language: "en", revision: 1 });
    dependencies.identity.mockResolvedValueOnce({
      status: "authenticated",
      user: {
        ...user,
        preferences: { language: "zh-Hans", revision: 3 },
      },
    });
    await access.checkSession();
    access.acceptPreferences(token, { language: "ja", revision: 2 });
    access.acceptPreferences(token, { language: "zh-Hant", revision: 3 });
    expect(access.getSnapshot().user?.preferences).toEqual({
      language: "zh-Hans",
      revision: 3,
    });
    expect(access.getSnapshot().mode).toBe("online");
  });

  it("fences an old save and old profile after logout and replacement-account activation", async () => {
    const { access, cache, dependencies } = fixture();
    await ready(access);
    const token = access.preferenceToken(user.userId)!;
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    const previousProfile = access.checkSession();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(2),
    );
    await access.logout();
    const replacement: IdentityProfile = {
      ...user,
      userId: crypto.randomUUID(),
      preferences: { language: "en", revision: 1 },
    };
    dependencies.identity.mockResolvedValueOnce({
      status: "authenticated",
      user: replacement,
    });
    await access.retry();
    await ready(access, false);
    const remembered = vi.mocked(cache.saveDisplayLanguage).mock.calls.length;
    expect(access.preferenceToken(user.userId)).toBeNull();
    expect(
      access.acceptPreferences(token, { language: "ja", revision: 99 }),
    ).toBe(false);
    held.resolve({
      status: "authenticated",
      user: { ...user, preferences: { language: "zh-Hant", revision: 100 } },
    });
    await previousProfile;
    expect(access.getSnapshot().user).toEqual(replacement);
    expect(cache.saveDisplayLanguage).toHaveBeenCalledTimes(remembered);
    expect(cache.invalidateAccount).toHaveBeenCalledOnce();
  });

  it("keeps an online saved choice when storage refuses its optional hint", async () => {
    const { access, cache, dependencies } = fixture();
    await ready(access);
    vi.mocked(cache.saveDisplayLanguage).mockResolvedValueOnce({
      kind: "unavailable",
      reason: "quota",
    });
    const stops = dependencies.stopPrivateWork.mock.calls.length;
    access.acceptPreferences(access.preferenceToken(user.userId)!, {
      language: "ja",
      revision: 1,
    });
    await vi.waitFor(() =>
      expect(access.getSnapshot().cacheAvailable).toBe(false),
    );
    expect(access.getSnapshot()).toMatchObject({
      mode: "online",
      user: { preferences: { language: "ja", revision: 1 } },
    });
    expect(dependencies.stopPrivateWork).toHaveBeenCalledTimes(stops);
    expect(renderLanguage(access)).toContain('lang="ja"');
  });

  it("uses a remembered hint only for its cold cached view and returns to browser fallback after retirement", async () => {
    const { access, cache } = fixture();
    const remembered: CachedAccount = {
      accountId: user.userId,
      label: user.displayName,
      fence,
      snapshots: [],
      displayLanguage: { fence, language: "ja", revision: 5 },
    };
    vi.mocked(cache.readAccount).mockResolvedValueOnce(ok(remembered));
    access.start(false);
    await vi.waitFor(() =>
      expect(access.getSnapshot().cachedAccount).toEqual(remembered),
    );
    expect(renderLanguage(access)).toContain('lang="ja"');
    expect(access.getSnapshot().user).toBeNull();
    await access.logout();
    expect(renderLanguage(access)).toContain('lang="zh-Hant"');
    expect(cache.saveDisplayLanguage).not.toHaveBeenCalled();
  });
});
