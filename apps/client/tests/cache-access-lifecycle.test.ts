import { deferred } from "@tests/shared/deferred";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type IdentityProfile } from "@vaskel/contracts/identity";
import type {
  AccountFence,
  CachedAccount,
} from "@/client/features/cache/model";
import {
  api,
  user,
  fence,
  owner,
  remembered,
  ok,
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
  it("enters cold cached history without identity and rejects a held read after local logout", async () => {
    const { access, cache, dependencies } = fixture();
    const held = deferred<ReturnType<typeof ok<CachedAccount>>>();
    vi.mocked(cache.readAccount).mockReturnValueOnce(held.promise);
    access.start(false);
    expect(access.getSnapshot()).toMatchObject({
      mode: "cached",
      user: null,
      canUseNetwork: false,
    });
    expect(dependencies.identity).not.toHaveBeenCalled();
    await access.logout();
    held.resolve(ok(remembered));
    await Promise.resolve();
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      user: null,
      cachedAccount: null,
    });
    expect(cache.clear).toHaveBeenCalledOnce();
  });

  it("keeps the authenticated account through a flap and readmits private requests only after fresh identity", async () => {
    const { access, dependencies, cache } = fixture();
    await authenticated(access);
    const firstUser = access.getSnapshot().user;
    const acceptedBeforeDisconnect = access.ownerToken(owner);
    const oldRequest = access.transport.begin(
      "/api/resources/server/a/send",
      {},
      {
        authority: "resource",
        owner: { kind: "server", id: "a" },
      },
    );
    access.disconnected();
    expect(access.getSnapshot()).toMatchObject({
      mode: "live-disconnected",
      user: firstUser,
      canUseNetwork: false,
    });
    expect(oldRequest.current()).toBe(false);
    expect(access.ownerReady(owner, acceptedBeforeDisconnect)).toBe(false);
    expect(cache.invalidateAccount).not.toHaveBeenCalled();
    const checked = deferred<{
      status: "authenticated";
      user: IdentityProfile;
    }>();
    dependencies.identity.mockReturnValueOnce(checked.promise);
    const reconnect = access.retry();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(2),
    );
    expect(access.getSnapshot().user).toBe(firstUser);
    expect(access.getSnapshot().canUseNetwork).toBe(false);
    expect(() =>
      access.transport.begin("/api/directory", {}, { authority: "account" }),
    ).toThrow();
    checked.resolve({ status: "authenticated", user });
    await reconnect;
    const attempt = access.getSnapshot().attempt;
    expect(access.getSnapshot().canUseNetwork).toBe(true);
    expect(oldRequest.current()).toBe(false);
    expect(access.ownerReady(owner, acceptedBeforeDisconnect)).toBe(false);
    expect(
      access.transport.begin("/api/directory", {}, { authority: "account" })
        .accountId,
    ).toBe(user.userId);
    await access.checkSession();
    expect(access.getSnapshot()).toMatchObject({ mode: "online", attempt });
  });

  it("closes logout immediately before durable invalidation and rejects held identity activation", async () => {
    const { access, cache, dependencies } = fixture();
    const identity = deferred<{
      status: "authenticated";
      user: IdentityProfile;
    }>();
    dependencies.identity.mockReturnValueOnce(identity.promise);
    access.start(true);
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledOnce(),
    );
    const removal = deferred<ReturnType<typeof ok<undefined>>>();
    vi.mocked(cache.invalidateAccount).mockReturnValueOnce(removal.promise);
    const logout = access.logout();
    expect(access.getSnapshot()).toMatchObject({
      mode: "signed-out",
      user: null,
    });
    identity.resolve({ status: "authenticated", user });
    await Promise.resolve();
    expect(cache.activateAccount).not.toHaveBeenCalled();
    removal.resolve(ok(undefined));
    await logout;
    expect(access.getSnapshot().mode).toBe("signed-out");
  });

  it("never enters cached fallback for HTTP/contract errors and preserves online access when storage is unavailable", async () => {
    const { access, dependencies, cache } = fixture();
    dependencies.identity.mockRejectedValueOnce(
      new api.ApiError("unavailable", 503),
    );
    access.start(true);
    await vi.waitFor(() => expect(access.getSnapshot().error).not.toBeNull());
    expect(cache.readAccount).not.toHaveBeenCalled();
    expect(access.getSnapshot().mode).toBe("reconnecting");
    vi.mocked(cache.captureAccount).mockResolvedValue({
      kind: "unavailable",
      reason: "storage",
    });
    await access.retry();
    expect(access.getSnapshot()).toMatchObject({
      mode: "online",
      cacheAvailable: false,
      accountFence: null,
    });
  });

  it("queues a session check behind the one in flight so a caller never inherits an older identity read", async () => {
    const { access, dependencies } = fixture();
    await authenticated(access);
    const polled = deferred<{
      status: "authenticated";
      user: IdentityProfile;
    }>();
    // The periodic check is already in flight when the caller changes a name.
    dependencies.identity.mockReturnValueOnce(polled.promise);
    const poll = access.checkSession();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(2),
    );
    let followed = false;
    const requested = access.checkSession();
    void requested.then(() => {
      followed = true;
    });
    // No second read may be issued while the first one is still outstanding.
    expect(dependencies.identity).toHaveBeenCalledTimes(2);
    const renamed = { ...user, displayName: "River Song" };
    dependencies.identity.mockResolvedValueOnce({
      status: "authenticated",
      user: renamed,
    });
    polled.resolve({ status: "authenticated", user });
    await poll;
    expect(followed).toBe(false);
    await requested;
    expect(dependencies.identity).toHaveBeenCalledTimes(3);
    expect(access.getSnapshot().user).toMatchObject({
      displayName: "River Song",
    });
    // Callers arriving together share one follow-up rather than stacking reads.
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    const first = access.checkSession();
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledTimes(4),
    );
    const second = access.checkSession();
    const third = access.checkSession();
    held.resolve({ status: "authenticated", user: renamed });
    await Promise.all([first, second, third]);
    expect(dependencies.identity).toHaveBeenCalledTimes(5);
    access.stop();
  });
});
describe("identity admission", () => {
  it("admits independent private reads after identity and cache activation without a navigation handshake", async () => {
    const { access, cache, dependencies } = fixture();
    const identity = deferred<{
      status: "authenticated";
      user: IdentityProfile;
    }>();
    const activation = deferred<ReturnType<typeof ok<AccountFence>>>();
    dependencies.identity.mockReturnValueOnce(identity.promise);
    vi.mocked(cache.activateAccount).mockReturnValueOnce(activation.promise);
    const paths = [
      "/api/directory",
      `/api/resources/server/${owner.id}`,
      `/api/resources/server/${owner.id}/snapshot`,
      "/api/account/events/ticket",
    ];
    access.start(true);
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledOnce(),
    );
    for (const path of paths)
      expect(() =>
        access.transport.begin(path, {}, { authority: "account" }),
      ).toThrow();
    identity.resolve({ status: "authenticated", user });
    await vi.waitFor(() =>
      expect(cache.activateAccount).toHaveBeenCalledOnce(),
    );
    expect(access.getSnapshot().canUseNetwork).toBe(false);
    activation.resolve(ok(fence));
    await vi.waitFor(() =>
      expect(access.getSnapshot().canUseNetwork).toBe(true),
    );
    for (const path of paths) {
      const request = access.transport.begin(
        path,
        {},
        { authority: "account" },
      );
      expect(request.accountId).toBe(user.userId);
      expect(request.current()).toBe(true);
    }
    await access.logout();
    for (const path of paths)
      expect(() =>
        access.transport.begin(path, {}, { authority: "account" }),
      ).toThrow();
    access.stop();
  });

  it("ignores a superseded identity failure after a later retry admitted the account", async () => {
    const { access, dependencies } = fixture();
    const identity = deferred<{
      status: "authenticated";
      user: IdentityProfile;
    }>();
    dependencies.identity.mockReturnValueOnce(identity.promise);
    access.start(true);
    await vi.waitFor(() =>
      expect(dependencies.identity).toHaveBeenCalledOnce(),
    );
    await access.retry();
    identity.reject(new api.ApiError("unavailable", 503));
    await Promise.resolve();
    expect(access.getSnapshot()).toMatchObject({
      mode: "online",
      user,
      canUseNetwork: true,
      error: null,
    });
    access.stop();
  });
});
