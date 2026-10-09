import { failureResponse, resourcePath } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type IdentityProfile } from "@vaskel/contracts/identity";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import {
  api,
  user,
  fence,
  owner,
  selected,
  ok,
  fixture,
  loadAccessModules,
} from "@tests/helpers/cache-access";

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  await loadAccessModules();
});
afterAll(() => vi.unstubAllGlobals());

describe("identity freshness deadlines", () => {
  async function open() {
    vi.useFakeTimers();
    const test = fixture();
    test.access.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.access.getSnapshot().canUseNetwork).toBe(true);
    const remove = api.installRequestAccess(test.access.transport);
    return {
      ...test,
      close() {
        remove();
        test.access.stop();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      },
    };
  }
  function renewal() {
    return Response.json({
      kind: "socket_renewed",
      connectionId: crypto.randomUUID(),
      leaseExpiresAt: Date.now() + 30_000,
    });
  }
  const renewPath = `/api/resources/server/${owner.id}/socket/renew`;

  it("preserves account recovery admission after a same-account cookie refresh and unrelated owner changes", async () => {
    const { access, dependencies, close } = await open();
    try {
      const token = access.accountToken();
      dependencies.identity.mockResolvedValueOnce({
        status: "authenticated",
        user: { ...user, expiresAt: "2031-01-01T00:00:00.000Z" },
      });
      access.invalidateOwnerView(owner);
      await access.checkSession();
      expect(access.accountCurrent(token)).toBe(true);
      expect(access.getSnapshot().user?.expiresAt).toBe(
        "2031-01-01T00:00:00.000Z",
      );
    } finally {
      close();
    }
  });

  it.each(["logout", "retry", "replacement", "same-account restart"])(
    "fences delayed recovery admission after %s even before React cleanup",
    async (change) => {
      const { access, cache, dependencies, close } = await open();
      try {
        const token = access.accountToken();
        if (change === "logout") await access.logout();
        else if (change === "retry" || change === "same-account restart") {
          if (change === "same-account restart") await access.logout();
          await access.retry();
        } else {
          const replacement = { ...user, userId: crypto.randomUUID() };
          dependencies.identity.mockResolvedValue({
            status: "authenticated",
            user: replacement,
          });
          vi.mocked(cache.captureAccount).mockResolvedValue(
            ok({ ...fence, accountId: null }),
          );
          vi.mocked(cache.activateAccount).mockResolvedValue(
            ok({ ...fence, accountId: replacement.userId }),
          );
          await access.checkSession();
          await vi.advanceTimersByTimeAsync(0);
          expect(access.getSnapshot().user?.userId).toBe(replacement.userId);
        }
        expect(access.accountCurrent(token)).toBe(false);
        if (change !== "logout")
          expect(access.accountCurrent(access.accountToken())).toBe(true);
      } finally {
        close();
      }
    },
  );

  it.each(["room", "media"])(
    "%s traffic satisfies validity while a five-minute profile read remains due",
    async (source) => {
      const { dependencies, close } = await open();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          source === "room"
            ? renewal()
            : Response.json({
                kind: "heartbeat",
                expiresAt: Date.now() + 30_000,
                snapshot: {
                  room: { owner, channelId: selected.channelId },
                  revision: 1,
                  participants: [],
                },
              }),
        ),
      );
      try {
        for (let i = 0; i < 14; i++) {
          await vi.advanceTimersByTimeAsync(20_000);
          if (source === "room")
            await api.requestWithInit(
              renewPath,
              MessagingOutcomeSchema,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              },
              { authority: "resource", owner: owner },
            );
          else
            await api.requestWithInit(
              "/api/media/heartbeat",
              MediaOutcomeSchema,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              },
              { authority: "media" },
            );
          expect(dependencies.identity).toHaveBeenCalledOnce();
          expect(vi.getTimerCount()).toBe(1);
        }
        await vi.advanceTimersByTimeAsync(20_000);
        expect(dependencies.identity).toHaveBeenCalledTimes(2);
      } finally {
        close();
      }
    },
  );

  it("checks idle documents while hidden, and stops all deadline work on disposal", async () => {
    const { access, dependencies, close } = await open();
    try {
      access.setVisible(false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(dependencies.identity).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(dependencies.identity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(dependencies.identity).toHaveBeenCalledTimes(3);
    } finally {
      close();
    }
  });

  it("leaves a failed resource read local while the existing identity deadline still freezes access on failed verification", async () => {
    const { access, dependencies, close } = await open();
    const token = access.accountToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
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
      expect(access.accountCurrent(token)).toBe(true);
      dependencies.identity.mockRejectedValueOnce(new api.NetworkError());
      await vi.advanceTimersByTimeAsync(29_999);
      expect(access.accountCurrent(token)).toBe(true);
      expect(dependencies.identity).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(dependencies.identity).toHaveBeenCalledTimes(2);
      expect(access.getSnapshot()).toMatchObject({
        mode: "live-disconnected",
        canUseNetwork: false,
      });
      expect(access.accountCurrent(token)).toBe(false);
    } finally {
      close();
    }
  });

  it("does not add hidden profile polling during sustained authenticated traffic", async () => {
    const { access, dependencies, close } = await open();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => renewal()),
    );
    try {
      access.setVisible(false);
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await api.requestWithInit(
          renewPath,
          MessagingOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "resource", owner: owner },
        );
      }
      expect(dependencies.identity).toHaveBeenCalledOnce();
      access.setVisible(true);
      await access.checkSession();
      expect(dependencies.identity).toHaveBeenCalledTimes(2);
    } finally {
      close();
    }
  });

  it("dates successful evidence from request start rather than delayed body completion", async () => {
    const { dependencies, close } = await open();
    const held = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => held.promise),
    );
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      const pending = api.requestWithInit(
        renewPath,
        MessagingOutcomeSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        { authority: "resource", owner: owner },
      );
      await vi.advanceTimersByTimeAsync(35_000);
      expect(dependencies.identity).toHaveBeenCalledTimes(2);
      held.resolve(renewal());
      await pending;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dependencies.identity).toHaveBeenCalledTimes(3);
    } finally {
      close();
    }
  });

  it("starts the identity deadline before a slow /me read, including during initial admission", async () => {
    vi.useFakeTimers();
    const { access, dependencies } = fixture();
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    try {
      access.start(true);
      await vi.advanceTimersByTimeAsync(35_000);
      held.resolve({ status: "authenticated", user });
      await vi.advanceTimersByTimeAsync(0);
      expect(dependencies.identity).toHaveBeenCalledTimes(2);
    } finally {
      access.stop();
      vi.useRealTimers();
    }
  });

  it("fresh traffic cannot consume the forced check queued behind a periodic read", async () => {
    const { access, dependencies, close } = await open();
    const held = deferred<{ status: "authenticated"; user: IdentityProfile }>();
    dependencies.identity.mockReturnValueOnce(held.promise);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => renewal()),
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      const forced = access.checkSession();
      await api.requestWithInit(
        renewPath,
        MessagingOutcomeSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        { authority: "resource", owner: owner },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      held.resolve({ status: "authenticated", user });
      await forced;
      expect(dependencies.identity).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      close();
    }
  });

  it.each([
    ["/api/instance?refresh=1", "success", { authority: "public" as const }],
    ["/api/identity/sign-out", "success", { authority: "cleanup" as const }],
    [renewPath, "malformed", { authority: "resource" as const, owner }],
    [renewPath, "failure", { authority: "resource" as const, owner }],
    [renewPath, "unavailable", { authority: "resource" as const, owner }],
    [renewPath, "stale", { authority: "resource" as const, owner }],
  ])(
    "does not refresh identity from excluded evidence: %s %s",
    async (path, result, scope) => {
      const { access, dependencies, close } = await open();
      const held = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => held.promise),
      );
      try {
        await vi.advanceTimersByTimeAsync(20_000);
        const pending = api
          .requestWithInit(
            path!,
            MessagingOutcomeSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            },
            scope,
          )
          .catch((error: unknown) => error);
        if (result === "stale") access.invalidateOwnerView(owner);
        held.resolve(
          result === "malformed"
            ? Response.json({ invalid: true })
            : result === "failure"
              ? failureResponse({ kind: "capacity" }, { status: 429 })
              : result === "unavailable"
                ? failureResponse({ kind: "socket_unavailable" })
                : renewal(),
        );
        await pending;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(dependencies.identity).toHaveBeenCalledTimes(2);
      } finally {
        close();
      }
    },
  );
});
