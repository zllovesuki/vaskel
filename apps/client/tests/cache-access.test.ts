import { assertKind, failureResponse, resourcePath } from "@tests/helpers/http";
import { QueryClient } from "@tanstack/react-query";
import { ResourceDirectorySchema } from "@vaskel/contracts/directory";
import {
  AdministrationOutcomeSchema,
  ServerAdministrationOutcomeSchema,
} from "@vaskel/contracts/administration";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EXPECTED_ACCOUNT_HEADER,
  IdentityMeResponseSchema,
} from "@vaskel/contracts/identity";
import { UpdateAccountPreferencesResponseSchema } from "@vaskel/contracts/preferences";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import {
  api,
  user,
  fence,
  owner,
  selected,
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

describe("timeline HTTP denial ownership", () => {
  it("one forbidden edit passes through transport and mutation handling and retires only its owner once", async () => {
    const { handleTimelineMutationFailure } =
      await import("@/client/features/chat/mutation-failure");
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    dependencies.invalidateCrossSearch.mockClear();
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const otherOwner = { ...owner, id: crypto.randomUUID() };
    const ownerKey = api.timelineKey(user.userId, owner, selected.channelId);
    const otherKey = api.timelineKey(user.userId, otherOwner, "other");
    client.setQueryData(ownerKey, { marker: "affected" });
    client.setQueryData(otherKey, { marker: "unrelated" });
    const before = JSON.parse(access.ownerToken(owner)) as unknown[];
    const unrelatedToken = access.ownerToken(otherOwner);
    const searchEpoch = access.getSnapshot().crossSearchEpoch;
    const removeAccess = api.installRequestAccess(access.transport);
    const fetcher = vi.fn(async () =>
      failureResponse({ kind: "forbidden" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetcher);
    // Timeline denial callbacks close local UI; transport owns retirement.
    const deny = vi.fn();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async () =>
        assertKind(
          await api.requestWithInit(
            `${resourcePath(owner)}/edit`,
            MessagingOutcomeSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channelId: selected.channelId,
                messageId: crypto.randomUUID(),
                expectedVersion: 1,
                commandId: crypto.randomUUID(),
                issuedAt: Date.now(),
                body: "replacement",
              }),
            },
            { authority: "resource", owner: owner },
          ),
          "accepted",
        ),
      onError: (error) =>
        handleTimelineMutationFailure(error, {
          client,
          userId: user.userId,
          deny,
          reconcile: vi.fn(),
        }),
    });
    try {
      await expect(mutation.execute(undefined)).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
      });
      await vi.waitFor(() =>
        expect(cache.invalidateOwner).toHaveBeenCalledOnce(),
      );
      const after = JSON.parse(access.ownerToken(owner)) as unknown[];
      expect(fetcher).toHaveBeenCalledOnce();
      expect(deny).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "forbidden", failure: "http" }),
      );
      expect(after.at(-1)).toBe(Number(before.at(-1)) + 1);
      expect(access.getSnapshot().crossSearchEpoch).toBe(searchEpoch);
      expect(dependencies.invalidateCrossSearch).toHaveBeenCalledOnce();
      expect(dependencies.invalidateOwner).toHaveBeenCalledOnce();
      expect(cache.captureScope).toHaveBeenCalledOnce();
      expect(
        vi
          .mocked(cache.invalidateOwner)
          .mock.calls.map(([capture]) => capture.owner),
      ).toEqual([owner]);
      expect(access.getSnapshot().deniedOwners).toEqual([`server:${owner.id}`]);
      expect(access.ownerToken(otherOwner)).toBe(unrelatedToken);
      expect(client.getQueryData(otherKey)).toEqual({ marker: "unrelated" });
      expect(access.getSnapshot().canUseNetwork).toBe(true);
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      // Fresh authorization is a new lifetime, with its own denial obligation.
      expect(access.ownerReady(owner, access.ownerToken(owner))).toBe(true);
      await expect(mutation.execute(undefined)).rejects.toMatchObject({
        code: "forbidden",
      });
      await vi.waitFor(() =>
        expect(cache.invalidateOwner).toHaveBeenCalledTimes(2),
      );
      expect(access.getSnapshot().crossSearchEpoch).toBe(searchEpoch);
      // The timeline hands the same HTTP error back; transport already reported it.
      await access.ownerDenied(
        owner,
        new api.ApiError("forbidden", 403, "http"),
      );
      expect(dependencies.invalidateOwner).toHaveBeenCalledTimes(2);
      expect(cache.invalidateOwner).toHaveBeenCalledTimes(2);
      // A socket access change never passed through transport and must purge.
      await access.ownerDenied(owner, socketDenial());
      expect(dependencies.invalidateOwner).toHaveBeenCalledTimes(3);
      expect(cache.invalidateOwner).toHaveBeenCalledTimes(3);
      expect(access.getSnapshot().crossSearchEpoch).toBe(searchEpoch);
    } finally {
      removeAccess();
      access.stop();
      client.clear();
    }
  });
});
describe("offline access lifetimes", () => {
  it("keeps account request network failure local and permits retry while its authentication denial still retires the account", async () => {
    const path = "/api/directory";
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const accountToken = access.accountToken();
    const ownerToken = access.ownerToken(owner);
    const stopped = dependencies.stopPrivateWork.mock.calls.length;
    const directory = {
      kind: "directory",
      resources: [],
      canCreateServers: false,
      partial: false,
      nextCursor: null,
    };
    const fetcher = vi
      .fn<(path: RequestInfo | URL, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json(directory))
      .mockResolvedValueOnce(
        failureResponse({ kind: "unauthenticated" }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const cleanup = api.installRequestAccess(access.transport);
    try {
      await expect(
        api.requestWithInit(
          path,
          ResourceDirectorySchema,
          { method: "GET" },
          { authority: "account" },
        ),
      ).rejects.toMatchObject({
        failure: "network",
      });
      expect(access.getSnapshot()).toMatchObject({
        mode: "online",
        canUseNetwork: true,
      });
      expect(access.accountCurrent(accountToken)).toBe(true);
      expect(access.ownerToken(owner)).toBe(ownerToken);
      expect(dependencies.stopPrivateWork).toHaveBeenCalledTimes(stopped);
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      expect(
        new Headers(fetcher.mock.calls[0]![1].headers).get(
          EXPECTED_ACCOUNT_HEADER,
        ),
      ).toBe(user.userId);
      await expect(
        api.requestWithInit(
          path,
          ResourceDirectorySchema,
          { method: "GET" },
          { authority: "account" },
        ),
      ).resolves.toEqual(directory);
      await expect(
        api.requestWithInit(
          path,
          ResourceDirectorySchema,
          { method: "GET" },
          { authority: "account" },
        ),
      ).rejects.toMatchObject({
        code: "unauthenticated",
        status: 401,
      });
      expect(access.getSnapshot().mode).toBe("signed-out");
      expect(access.accountCurrent(accountToken)).toBe(false);
      expect(dependencies.closeAccount).toHaveBeenCalledOnce();
      expect(cache.invalidateAccount).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("keeps account access and unrelated work current after an owner request network failure", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const accountToken = access.accountToken();
    const ownerToken = access.ownerToken(owner);
    const unrelatedOwner = { ...owner, id: crypto.randomUUID() };
    const unrelated = access.transport.begin(
      `${resourcePath(unrelatedOwner)}/snapshot`,
      { method: "POST" },
      { authority: "resource", owner: unrelatedOwner },
    );
    const stopped = dependencies.stopPrivateWork.mock.calls.length;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    const cleanup = api.installRequestAccess(access.transport);
    try {
      await expect(
        api.requestWithInit(
          `${resourcePath(owner)}/snapshot`,
          MessagingOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channelId: selected.channelId }),
          },
          { authority: "resource", owner: owner },
        ),
      ).rejects.toMatchObject({ failure: "network" });
      expect(access.getSnapshot()).toMatchObject({
        mode: "online",
        canUseNetwork: true,
        user,
      });
      expect(access.accountCurrent(accountToken)).toBe(true);
      expect(access.ownerToken(owner)).toBe(ownerToken);
      expect(unrelated.current()).toBe(true);
      expect(dependencies.stopPrivateWork).toHaveBeenCalledTimes(stopped);
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("still freezes private requests on explicit disconnection or failed identity verification", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const original = access.accountToken();
    access.disconnected();
    expect(access.getSnapshot()).toMatchObject({
      mode: "live-disconnected",
      canUseNetwork: false,
      user,
    });
    expect(access.accountCurrent(original)).toBe(false);
    expect(() =>
      access.transport.begin("/api/directory", {}, { authority: "account" }),
    ).toThrow();
    await access.retry();
    const replacement = access.accountToken();
    expect(access.accountCurrent(replacement)).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    const cleanup = api.installRequestAccess(access.transport);
    const stopped = dependencies.stopPrivateWork.mock.calls.length;
    try {
      await expect(
        api.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({ failure: "network" });
      expect(access.getSnapshot()).toMatchObject({
        mode: "live-disconnected",
        canUseNetwork: false,
        user,
      });
      expect(access.accountCurrent(replacement)).toBe(false);
      expect(dependencies.stopPrivateWork).toHaveBeenCalledTimes(stopped + 1);
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      expect(() =>
        access.transport.begin("/api/directory", {}, { authority: "account" }),
      ).toThrow();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("binds private requests to the displayed account and preserves the original identity through delayed sign-out", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const { signOut } = await import("@/client/features/auth/session-state");
    const fetcher = vi.fn<
      (path: RequestInfo | URL, init: RequestInit) => Promise<Response>
    >(async (path) =>
      path === "/api/account/preferences"
        ? Response.json({
            kind: "preferences_updated",
            preferences: { language: "ja", revision: 1 },
          })
        : new URL(
              path instanceof Request ? path.url : String(path),
              "https://vaskel.test",
            ).pathname === "/api/identity/sign-out"
          ? failureResponse({ status: "unauthenticated" }, { status: 401 })
          : Response.json({ status: "authenticated", user }),
    );
    vi.stubGlobal("fetch", fetcher);
    const cleanup = api.installRequestAccess(access.transport);
    try {
      await api.requestWithInit(
        "/api/account/preferences",
        UpdateAccountPreferencesResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: "ja" }),
        },
        { authority: "account" },
      );
      await api.requestWithInit(
        "/api/identity/me",
        IdentityMeResponseSchema,
        { method: "GET" },
        { authority: "identity" },
      );
      await api.requestWithInit(
        "/api/identity/sign-in",
        IdentityMeResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        { authority: "public" },
      );
      const header = (index: number) =>
        new Headers(fetcher.mock.calls[index]![1].headers).get(
          EXPECTED_ACCOUNT_HEADER,
        );
      expect(header(0)).toBe(user.userId);
      expect(header(1)).toBeNull();
      expect(header(2)).toBeNull();

      const originalAccount = user.userId;
      await access.logout();
      const replacement = { ...user, userId: crypto.randomUUID() };
      dependencies.identity.mockResolvedValue({
        status: "authenticated",
        user: replacement,
      });
      vi.mocked(cache.captureAccount).mockResolvedValue(
        ok({ ...fence, accountId: null }),
      );
      vi.mocked(cache.activateAccount).mockResolvedValue(
        ok({
          ...fence,
          accountId: replacement.userId,
        }),
      );
      await access.retry();
      const current = access.getSnapshot();
      await expect(signOut(originalAccount)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
      expect(header(3)).toBe(originalAccount);
      access.signOutFailed(new api.ApiError("unauthenticated", 401));
      expect(access.getSnapshot()).toBe(current);
      expect(cache.invalidateAccount).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("binds account self-service to the displayed account, gates it offline, and closes the view when the cookie no longer matches", async () => {
    const { access, dependencies } = fixture();
    await authenticated(access);
    const { UpdateProfileResponseSchema, ListSessionsResponseSchema } =
      await import("@vaskel/contracts/account");
    const fetcher = vi.fn<
      (path: RequestInfo | URL, init: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({ status: "profile_updated", displayName: "Rain" }),
    );
    vi.stubGlobal("fetch", fetcher);
    const cleanup = api.installRequestAccess(access.transport);
    try {
      await api.requestWithInit(
        "/api/identity/profile",
        UpdateProfileResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Rain",
          }),
        },
        { authority: "self-service" },
      );
      const headers = new Headers(fetcher.mock.calls[0]![1].headers);
      expect(headers.get(EXPECTED_ACCOUNT_HEADER)).toBe(user.userId);
      // The server refuses a request whose bound account is not the cookie's
      // account (a replacement sign-in in another tab); this view closes and
      // never acts on the other account.
      fetcher.mockResolvedValueOnce(
        failureResponse({ status: "unauthenticated" }, { status: 401 }),
      );
      await expect(
        api.requestWithInit(
          "/api/identity/profile",
          UpdateProfileResponseSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Rain",
            }),
          },
          { authority: "self-service" },
        ),
      ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
      expect(access.getSnapshot().mode).toBe("signed-out");
      expect(dependencies.closeAccount).toHaveBeenCalledOnce();
      // Signed out, the sessions list is blocked at the gate, not sent.
      await expect(
        api.requestWithInit(
          "/api/identity/sessions",
          ListSessionsResponseSchema,
          { method: "GET" },
          { authority: "self-service" },
        ),
      ).rejects.toMatchObject({ code: "offline" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("keeps the session through a wrong current password but ends it for any other 401 on account self-service", async () => {
    const { access, dependencies } = fixture();
    await authenticated(access);
    const { ChangePasswordResponseSchema } =
      await import("@vaskel/contracts/account");
    const fetcher = vi.fn<
      (path: RequestInfo | URL, init: RequestInit) => Promise<Response>
    >(async () =>
      failureResponse({ status: "invalid_credentials" }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const cleanup = api.installRequestAccess(access.transport);
    const input = {
      currentPassword: "not the one",
      newPassword: "a-much-longer-new-passphrase",
      revokeOtherSessions: false,
    };
    try {
      await expect(
        api.requestWithInit(
          "/api/identity/change-password",
          ChangePasswordResponseSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
          { authority: "self-service" },
        ),
      ).rejects.toMatchObject({ code: "invalid_credentials", status: 401 });
      expect(access.getSnapshot().mode).toBe("online");
      expect(access.getSnapshot().canUseNetwork).toBe(true);
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      // A malformed 401 body carries no validated answer and stays terminal.
      fetcher.mockResolvedValueOnce(
        new Response("<html>denied</html>", { status: 401 }),
      );
      await expect(
        api.requestWithInit(
          "/api/identity/change-password",
          ChangePasswordResponseSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
          { authority: "self-service" },
        ),
      ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
      expect(access.getSnapshot().mode).toBe("signed-out");
      expect(dependencies.closeAccount).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("keeps the owner open when a jump or a reaction names a message that is not there", async () => {
    const { access, dependencies } = fixture();
    await authenticated(access);
    const fetcher = vi.fn<
      (path: RequestInfo | URL, init: RequestInit) => Promise<Response>
    >(async () => failureResponse({ kind: "not_found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const cleanup = api.installRequestAccess(access.transport);
    const base = `/api/resources/server/${owner.id}`;
    try {
      for (const operation of ["around", "react"]) {
        await expect(
          api.requestWithInit(
            `${base}/${operation}`,
            MessagingOutcomeSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channelId: selected.channelId,
              }),
            },
            { authority: "message", owner: owner },
          ),
        ).rejects.toMatchObject({ code: "not_found", status: 404 });
      }
      expect(access.getSnapshot().deniedOwners).toEqual([]);
      expect(access.getSnapshot().canUseNetwork).toBe(true);
      expect(dependencies.invalidateOwner).not.toHaveBeenCalled();
      // The owner itself answering not_found still retires the view.
      await expect(
        api.requestWithInit(
          `${base}/snapshot`,
          MessagingOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channelId: selected.channelId,
            }),
          },
          { authority: "resource", owner: owner },
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      await vi.waitFor(() =>
        expect(access.getSnapshot().deniedOwners).toContain(
          `server:${owner.id}`,
        ),
      );
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("keeps account and text-owner lifetimes through media denials including a malformed HTTP 403", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const current = access.getSnapshot();
    const token = access.ownerToken(owner);
    const cleanup = api.installRequestAccess(access.transport);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          failureResponse(
            { kind: "action_restricted", restriction: "deafen" },
            { status: 403 },
          ),
        )
        .mockResolvedValueOnce(
          failureResponse({ kind: "forbidden" }, { status: 403 }),
        )
        .mockResolvedValueOnce(
          new Response("<html>denied</html>", { status: 403 }),
        ),
    );
    try {
      await expect(
        api.requestWithInit(
          "/api/media/subscribe",
          MediaOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "media" },
        ),
      ).rejects.toMatchObject({ code: "action_restricted" });
      await expect(
        api.requestWithInit(
          "/api/media/heartbeat",
          MediaOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "media" },
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(access.getSnapshot()).toBe(current);
      expect(access.ownerToken(owner)).toBe(token);
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      await expect(
        api.requestWithInit(
          "/api/media/heartbeat",
          MediaOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "media" },
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
        failure: "http",
      });
      expect(access.getSnapshot().mode).toBe("online");
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it("keeps a transferred owner's account and message lifetime when the refreshed administration capability is forbidden", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const current = access.getSnapshot();
    const token = access.ownerToken(owner);
    const cleanup = api.installRequestAccess(access.transport);
    const base = `/api/servers/${owner.id}`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ kind: "changed", version: 2 }))
        .mockResolvedValueOnce(
          failureResponse({ kind: "forbidden" }, { status: 403 }),
        ),
    );
    try {
      await expect(
        api.requestWithInit(
          `${base}/transfer`,
          AdministrationOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetId: "next-owner",
              expectedVersion: 1,
            }),
          },
          { authority: "capability" },
        ),
      ).resolves.toEqual({ kind: "changed", version: 2 });
      await expect(
        api.requestWithInit(
          `${base}/administration`,
          ServerAdministrationOutcomeSchema,
          { method: "GET" },
          { authority: "capability" },
        ),
      ).rejects.toMatchObject({ code: "forbidden", status: 403 });
      expect(access.getSnapshot()).toBe(current);
      expect(access.ownerToken(owner)).toBe(token);
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      expect(dependencies.invalidateOwner).not.toHaveBeenCalled();
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      expect(cache.invalidateOwner).not.toHaveBeenCalled();
    } finally {
      cleanup();
      access.stop();
    }
  });

  it.each([
    ["invites", "forbidden", 403],
    ["update-channel", "not_found", 404],
  ] as const)(
    "treats a scoped %s capability failure as a local operation result",
    async (action, kind, status) => {
      const { access, cache, dependencies } = fixture();
      await authenticated(access);
      const current = access.getSnapshot();
      const cleanup = api.installRequestAccess(access.transport);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ kind }, { status })),
      );
      try {
        await expect(
          api.requestWithInit(
            `/api/servers/${owner.id}/${action}`,
            AdministrationOutcomeSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            },
            { authority: "capability" },
          ),
        ).rejects.toMatchObject({ code: kind, status });
        expect(access.getSnapshot()).toBe(current);
        expect(dependencies.closeAccount).not.toHaveBeenCalled();
        expect(cache.invalidateOwner).not.toHaveBeenCalled();
      } finally {
        cleanup();
        access.stop();
      }
    },
  );

  it.each(["unauthenticated", "malformed-401"])(
    "preserves terminal administration transport failures (%s)",
    async (failure) => {
      const { access, cache, dependencies } = fixture();
      await authenticated(access);
      const cleanup = api.installRequestAccess(access.transport);
      const status = 401;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          failure === "unauthenticated"
            ? failureResponse({ kind: "unauthenticated" }, { status })
            : new Response("<html>denied</html>", { status }),
        ),
      );
      try {
        await expect(
          api.requestWithInit(
            `/api/servers/${owner.id}/administration`,
            ServerAdministrationOutcomeSchema,
            { method: "GET" },
            { authority: "capability" },
          ),
        ).rejects.toMatchObject({
          code: status === 401 ? "unauthenticated" : "forbidden",
          status,
        });
        expect(access.getSnapshot().mode).toBe("signed-out");
        expect(dependencies.closeAccount).toHaveBeenCalledOnce();
        expect(cache.invalidateAccount).toHaveBeenCalledOnce();
      } finally {
        cleanup();
        access.stop();
      }
    },
  );
});
