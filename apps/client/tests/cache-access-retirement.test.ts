import { deferred } from "@tests/shared/deferred";
import { HISTORY_FORMAT } from "@/client/features/cache/model";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EXPECTED_ACCOUNT_HEADER,
  type IdentityProfile,
} from "@vaskel/contracts/identity";
import { QueryClient } from "@tanstack/react-query";
import type {
  CachedSnapshot,
  HistoryCache,
} from "@/client/features/cache/model";
import {
  api,
  user,
  fence,
  owner,
  remembered,
  ok,
  socketDenial,
  fixture,
  authenticated,
  loadAccessModules,
} from "@tests/helpers/cache-access";

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  await loadAccessModules();
});
afterAll(() => vi.unstubAllGlobals());

describe("offline access lifetimes", () => {
  it("retires inactive owner history on content changes while retaining point-in-time search copies", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    dependencies.invalidateCrossSearch.mockClear();
    const search = access.crossSearchToken();
    const activeWindow = access.ownerToken(owner);
    const held = deferred<Awaited<ReturnType<HistoryCache["captureScope"]>>>();
    vi.mocked(cache.captureScope).mockReturnValueOnce(held.promise);
    const invalidation = access.invalidateOwnerContent(owner);
    expect(access.crossSearchCurrent(search)).toBe(true);
    expect(dependencies.invalidateCrossSearch).not.toHaveBeenCalled();
    expect(access.ownerToken(owner)).toBe(activeWindow);
    expect(access.getSnapshot().invalidatedOwners).toEqual([]);
    expect(access.getSnapshot().deniedOwners).toEqual([]);
    expect(dependencies.invalidateOwner).not.toHaveBeenCalled();
    // Network loss must not restore content that was known stale while online.
    access.disconnected();
    const scope = {
      ...fence,
      owner,
      retirementRevision: 0,
      scopeEpoch: crypto.randomUUID(),
      generation: crypto.randomUUID(),
    };
    held.resolve(ok(scope));
    await invalidation;
    expect(cache.invalidateOwner).toHaveBeenCalledExactlyOnceWith(scope);
    access.stop();
  });

  it("does not let an old content invalidation retire a replacement account", async () => {
    const { access, cache } = fixture();
    await authenticated(access);
    const held = deferred<Awaited<ReturnType<HistoryCache["captureScope"]>>>();
    vi.mocked(cache.captureScope).mockReturnValueOnce(held.promise);
    const invalidation = access.invalidateOwnerContent(owner);
    await access.logout();
    held.resolve(
      ok({
        ...fence,
        owner,
        retirementRevision: 0,
        scopeEpoch: crypto.randomUUID(),
        generation: null,
      }),
    );
    await invalidation;
    expect(cache.invalidateOwner).not.toHaveBeenCalled();
    access.stop();
  });

  it("recovers an authorized sibling channel without restoring a revoked owner's old cache or accepting a stale snapshot", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const beforeRevocation = access.ownerToken(owner);
    await access.ownerDenied(owner, socketDenial());
    expect(access.getSnapshot().deniedOwners).toContain(`server:${owner.id}`);
    expect(cache.invalidateOwner).toHaveBeenCalledOnce();
    expect(dependencies.invalidateOwner).toHaveBeenCalledWith(
      owner,
      user.userId,
      true,
    );
    expect(access.ownerReady(owner, beforeRevocation)).toBe(false);
    // A fresh, owner-authorized sibling snapshot arrives after the denial.
    const siblingSnapshot = access.ownerToken(owner);
    expect(access.ownerReady(owner, siblingSnapshot)).toBe(true);
    expect(access.getSnapshot().deniedOwners).toEqual([]);
    expect(cache.authorizeScope).not.toHaveBeenCalled();
    expect(cache.save).not.toHaveBeenCalled();
    await access.ownerDenied(owner, socketDenial());
    expect(access.ownerReady(owner, siblingSnapshot)).toBe(false);
    expect(access.getSnapshot().deniedOwners).toContain(`server:${owner.id}`);
    access.stop();
  });

  it.each(["denied", "invalidated"] as const)(
    "rejects a delayed global search after an owner is %s without retiring unrelated account requests",
    async (change) => {
      const { access, dependencies } = fixture();
      await authenticated(access);
      const held = deferred<Response>();
      const fetcher = vi.fn<
        (path: string, init: RequestInit) => Promise<Response>
      >(() => held.promise);
      vi.stubGlobal("fetch", fetcher);
      const cleanup = api.installRequestAccess(access.transport);
      const token = access.crossSearchToken();
      const epoch = access.getSnapshot().crossSearchEpoch;
      const unrelated = access.transport.begin(
        "/api/account/preferences",
        {},
        { authority: "account" },
      );
      const client = new QueryClient();
      const { invalidateCrossSearch } =
        await import("@/client/features/search/invalidate");
      const { crossSearchOptions } =
        await import("@/client/features/search/query");
      dependencies.invalidateCrossSearch.mockImplementation(
        (accountId, scope) => invalidateCrossSearch(client, accountId, scope),
      );
      const pending = client.fetchInfiniteQuery(
        crossSearchOptions(user.userId, { q: "hello" }, epoch, {
          capture: access.crossSearchToken,
          current: access.crossSearchCurrent,
        }),
      );
      const rejected = expect(pending).rejects.toThrow();
      try {
        if (change === "denied")
          await access.ownerDenied(owner, socketDenial());
        else access.invalidateOwnerView(owner);
        expect(access.getSnapshot().crossSearchEpoch).toBe(epoch);
        expect(access.crossSearchCurrent(token)).toBe(true);
        expect(dependencies.invalidateCrossSearch).toHaveBeenCalledWith(
          user.userId,
          owner,
        );
        expect(unrelated.current()).toBe(true);
        expect(access.getSnapshot().canUseNetwork).toBe(true);
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
        await rejected;
        expect(
          new Headers(fetcher.mock.calls[0]?.[1]?.headers).get(
            EXPECTED_ACCOUNT_HEADER,
          ),
        ).toBe(user.userId);
      } finally {
        client.clear();
        cleanup();
        access.stop();
      }
    },
  );

  it("retires search across reconnect and readmits a new search lifetime after fresh identity", async () => {
    const { access, dependencies } = fixture();
    await authenticated(access);
    const token = access.crossSearchToken();
    const epoch = access.getSnapshot().crossSearchEpoch;
    access.disconnected();
    expect(access.crossSearchCurrent(token)).toBe(false);
    expect(access.getSnapshot().crossSearchEpoch).toBeGreaterThan(epoch);
    expect(() =>
      access.transport.begin(
        "/api/account/search",
        {},
        { authority: "account", freshness: "search" },
      ),
    ).toThrow();
    await access.retry();
    expect(access.getSnapshot()).toMatchObject({
      mode: "online",
      canUseNetwork: true,
    });
    expect(
      access.transport.begin(
        "/api/account/search",
        {},
        { authority: "account", freshness: "search" },
      ).accountId,
    ).toBe(user.userId);
    expect(access.crossSearchCurrent(token)).toBe(false);
    expect(access.crossSearchCurrent(access.crossSearchToken())).toBe(true);
    expect(dependencies.invalidateCrossSearch).toHaveBeenCalledTimes(2);
    access.stop();
  });

  it("handles remote invalidation without treating a local projection checkpoint as lost live access", async () => {
    const { access, dependencies, cache } = fixture();
    await authenticated(access);
    const epoch = {
      type: "owner" as const,
      ...fence,
      owner,
      retirementRevision: 0,
      scopeEpoch: crypto.randomUUID(),
      generation: crypto.randomUUID(),
    };
    access.cacheChanged(epoch, "local");
    expect(access.getSnapshot().invalidatedOwners).toEqual([]);
    const pendingOwnerRequest = access.transport.begin(
      `/api/resources/server/${owner.id}/snapshot`,
      {},
      {
        authority: "resource",
        owner: { kind: "server", id: owner.id },
      },
    );
    const decodedSnapshot = access.ownerToken(owner);
    access.cacheChanged({ ...epoch, type: "evicted" }, "remote");
    expect(access.ownerToken(owner)).toBe(decodedSnapshot);
    expect(pendingOwnerRequest.current()).toBe(true);
    expect(dependencies.invalidateOwner).not.toHaveBeenCalled();
    access.cacheChanged(epoch, "remote");
    expect(access.getSnapshot()).toMatchObject({
      mode: "online",
      invalidatedOwners: [`server:${owner.id}`],
    });
    expect(access.ownerReady(owner, decodedSnapshot)).toBe(false);
    expect(access.getSnapshot().invalidatedOwners).toEqual([
      `server:${owner.id}`,
    ]);
    expect(access.ownerReady(owner, access.ownerToken(owner))).toBe(true);
    expect(access.getSnapshot().invalidatedOwners).toEqual([]);
    expect(pendingOwnerRequest.current()).toBe(false);
    expect(dependencies.invalidateOwner).toHaveBeenCalledWith(
      owner,
      user.userId,
      false,
    );
    access.cacheChanged({ type: "account", ...fence }, "remote");
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      user: null,
    });
    expect(dependencies.closeAccount).toHaveBeenCalled();
    expect(cache.invalidateAccount).not.toHaveBeenCalled();
  });

  it("keeps a denied account closed through subsequent offline hints and rejects stale activation after durable invalidation", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    const checking = access.checkSession();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(2),
    );
    access.transport.failed(
      "/api/identity/me",
      new api.ApiError("unauthenticated", 401),
      { authority: "identity" },
    );
    held.reject(new api.ApiError("unavailable", 503));
    await checking;
    access.disconnected();
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      cachedAccount: null,
    });
    expect(cache.readAccount).not.toHaveBeenCalled();
    vi.mocked(cache.activateAccount).mockResolvedValueOnce({ kind: "stale" });
    await access.retry();
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      user: null,
    });
  });

  it("retires a verified previous account before a failing second identity request can reopen its cache", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const removal = deferred<ReturnType<typeof ok<undefined>>>();
    vi.mocked(cache.invalidateAccount).mockReturnValueOnce(removal.promise);
    dependencies.identity.mockResolvedValueOnce({
      status: "authenticated",
      user: { ...user, userId: "00000000-0000-4000-8000-000000000099" },
    });
    const freshness = access.checkSession();
    await vi.waitFor(() =>
      expect(cache.invalidateAccount).toHaveBeenCalledWith(fence),
    );
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      user: null,
    });
    access.disconnected();
    expect(cache.readAccount).not.toHaveBeenCalled();
    vi.mocked(cache.readAccount).mockResolvedValueOnce({ kind: "miss" });
    dependencies.identity.mockRejectedValueOnce(new api.NetworkError());
    removal.resolve(ok(undefined));
    await freshness;
    await vi.waitFor(() => expect(access.getSnapshot().mode).toBe("cached"));
    expect(access.getSnapshot()).toMatchObject({
      user: null,
      cachedAccount: null,
    });
    expect(cache.activateAccount).toHaveBeenCalledTimes(1);
  });

  it("does not republish an earlier owner's snapshot when its purge arrives during a later owner's held cache check", async () => {
    const { access, cache } = fixture();
    function snapshot(id: string): CachedSnapshot {
      const scope = { kind: "server" as const, id };
      const generation = crypto.randomUUID();
      return {
        format: HISTORY_FORMAT,
        fence: {
          ...fence,
          owner: scope,
          retirementRevision: 0,
          scopeEpoch: crypto.randomUUID(),
          generation,
        },
        cursor: {
          owner: scope,
          channelId: `channel-${id}`,
          generation,
          sequence: 0,
        },
        messages: [],
        nextBefore: null,
        labels: { owner: id, channel: id, authors: [] },
        savedAt: 1,
        byteLength: 0,
      };
    }
    const a = snapshot("a");
    const b = snapshot("b");
    vi.mocked(cache.readAccount)
      .mockResolvedValueOnce(ok({ ...remembered, snapshots: [a, b] }))
      .mockResolvedValueOnce(ok({ ...remembered, snapshots: [b] }));
    const held = deferred<ReturnType<typeof ok<undefined>>>();
    vi.mocked(cache.recheck)
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(ok(undefined))
      .mockReturnValueOnce(held.promise);
    access.start(false);
    await vi.waitFor(() => expect(cache.recheck).toHaveBeenCalledTimes(3));
    access.cacheChanged({ type: "owner", ...a.fence }, "remote");
    await vi.waitFor(() =>
      expect(access.getSnapshot().cachedAccount?.snapshots).toEqual([b]),
    );
    held.resolve(ok(undefined));
    await Promise.resolve();
    expect(access.getSnapshot().cachedAccount?.snapshots).toEqual([b]);
  });

  it("withdraws a cold remembered account immediately after a different identity is verified, before a held purge finishes", async () => {
    const { access, cache, dependencies } = fixture();
    access.start(false);
    await vi.waitFor(() =>
      expect(access.getSnapshot().cachedAccount).toEqual(remembered),
    );
    dependencies.identity.mockResolvedValueOnce({
      status: "authenticated",
      user: { ...user, userId: "00000000-0000-4000-8000-000000000099" },
    });
    const removal = deferred<ReturnType<typeof ok<undefined>>>();
    vi.mocked(cache.invalidateAccount).mockReturnValueOnce(removal.promise);
    const reconnect = access.retry();
    await vi.waitFor(() =>
      expect(cache.invalidateAccount).toHaveBeenCalledWith(fence),
    );
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      cachedAccount: null,
      user: null,
    });
    expect(cache.activateAccount).not.toHaveBeenCalled();
    access.stop();
    removal.resolve(ok(undefined));
    await reconnect;
    expect(dependencies.identity).toHaveBeenCalledOnce();
  });

  it("allows local removal to cancel a cold reconnect without leaving the identity spinner or accepting its late result", async () => {
    const { access, cache, dependencies } = fixture();
    access.start(false);
    await vi.waitFor(() =>
      expect(access.getSnapshot().cachedAccount).toEqual(remembered),
    );
    const identity = deferred<{
      status: "authenticated";
      user: IdentityProfile;
    }>();
    dependencies.identity.mockReturnValueOnce(identity.promise);
    const reconnect = access.retry();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledOnce(),
    );
    await access.removeCached();
    expect(access.getSnapshot()).toMatchObject({
      mode: "cached",
      cachedAccount: null,
    });
    identity.resolve({ status: "authenticated", user });
    await reconnect;
    expect(cache.activateAccount).not.toHaveBeenCalled();
    expect(access.getSnapshot().user).toBeNull();
  });
});
