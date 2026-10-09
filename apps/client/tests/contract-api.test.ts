import { ORPCError } from "@orpc/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import {
  authenticated,
  fixture,
  loadAccessModules,
  owner,
  user,
} from "@tests/helpers/cache-access";

let transport: typeof import("@/client/api/client");
let api: typeof import("@/client/api/contract").api;
let resourceOptions: typeof import("@/client/features/workspace/resource-query").resourceOptions;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  vi.stubGlobal("location", { origin: "https://vaskel.test" });
  await loadAccessModules();
  transport = await import("@/client/api/client");
  ({ api } = await import("@/client/api/contract"));
  ({ resourceOptions } =
    await import("@/client/features/workspace/resource-query"));
});
afterAll(() => vi.unstubAllGlobals());

const command = {
  commandId: "exact-command",
  issuedAt: 10,
  channelId: "general",
  body: "Hello",
  attachmentIds: [],
};

describe("contract client and existing browser acceptance", () => {
  it("generates the existing JSON command wire and preserves expected-account and bookmark scoping", async () => {
    const { activateTransport } = await import("@/client/api/bookmark");
    const endBookmark = activateTransport(user.userId);
    const end = transport.installRequestAccess({
      begin: () => ({ current: () => true, accountId: user.userId }),
      failed: vi.fn(),
    });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (request: Request, init: RequestInit) => {
      requests.push(new Request(request, init));
      return Response.json(
        new ORPCError("DM_BLOCKED", {
          defined: true,
          status: 409,
          data: { kind: "dm_blocked" },
        }).toJSON(),
        { status: 409, headers: { "X-Vaskel-D1-Bookmark": "bookmark-a" } },
      );
    });
    try {
      await expect(
        api.send({ params: owner, body: command }),
      ).rejects.toMatchObject({
        code: "DM_BLOCKED",
        data: { kind: "dm_blocked" },
      });
      await expect(
        api.send({ params: owner, body: command }),
      ).rejects.toMatchObject({
        code: "DM_BLOCKED",
        data: { kind: "dm_blocked" },
      });
      const { isDefiniteSendRejection } =
        await import("@/client/features/chat/mutation-failure");
      const failure = new ORPCError("DM_BLOCKED", {
        defined: true,
        status: 409,
        data: { kind: "dm_blocked" },
      });
      expect(isDefiniteSendRejection(failure)).toBe(true);
      expect(isDefiniteSendRejection(failure, true)).toBe(false);
      expect(new URL(requests[0]!.url).pathname).toBe(
        `/api/resources/server/${owner.id}/send`,
      );
      expect(requests[0]!.method).toBe("POST");
      expect(await requests[0]!.json()).toEqual(command);
      expect(requests[0]!.headers.get(EXPECTED_ACCOUNT_HEADER)).toBe(
        user.userId,
      );
      expect(requests[1]!.headers.get("X-Vaskel-D1-Bookmark")).toBe(
        "bookmark-a",
      );
    } finally {
      end();
      endBookmark();
    }
  });

  it.each([401, 403, 404])(
    "retains terminal HTTP %s even when the body is unreadable",
    async (status) => {
      const failed = vi.fn();
      const end = transport.installRequestAccess({
        begin: () => ({ current: () => true, accountId: user.userId }),
        failed,
      });
      vi.stubGlobal(
        "fetch",
        async () => new Response("<html>denied</html>", { status }),
      );
      try {
        await expect(api.resource({ params: owner })).rejects.toMatchObject({
          status,
        });
        expect(failed).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ status, failure: "http" }),
          expect.objectContaining({ authority: "resource", owner }),
        );
      } finally {
        end();
      }
    },
  );

  it.each([403, 404])(
    "keeps capability HTTP %s local without inferring it from the URL",
    async (status) => {
      const { access, cache, dependencies } = fixture();
      await authenticated(access);
      const current = access.getSnapshot();
      const end = transport.installRequestAccess(access.transport);
      vi.stubGlobal("fetch", async () => new Response("denied", { status }));
      try {
        await expect(
          api.administration({ params: { id: owner.id } }),
        ).rejects.toMatchObject({
          code: status === 403 ? "FORBIDDEN" : "NOT_FOUND",
          status,
        });
        expect(access.getSnapshot()).toBe(current);
        expect(dependencies.closeAccount).not.toHaveBeenCalled();
        expect(dependencies.invalidateOwner).not.toHaveBeenCalled();
        expect(cache.invalidateAccount).not.toHaveBeenCalled();
        expect(cache.invalidateOwner).not.toHaveBeenCalled();
        // The same semantic authority is independent of a future route spelling.
        access.transport.failed(
          "/arbitrary/capability",
          new transport.ApiError("forbidden", status),
          { authority: "capability" },
        );
        expect(access.getSnapshot()).toBe(current);
      } finally {
        end();
        access.stop();
      }
    },
  );

  it("rejects malformed outcomes and late bodies without advancing identity freshness", async () => {
    let current = true;
    const succeeded = vi.fn();
    const end = transport.installRequestAccess({
      begin: () => ({ current: () => current, accountId: user.userId }),
      failed: vi.fn(),
      succeeded,
    });
    vi.stubGlobal("fetch", async () =>
      Response.json({ kind: "socket_renewed", connectionId: "invalid" }),
    );
    try {
      await expect(
        api.socketRenew({
          params: owner,
          body: { channelId: "general", connectionId: crypto.randomUUID() },
        }),
      ).rejects.toMatchObject({ failure: "contract" });
      let finish!: (response: Response) => void;
      vi.stubGlobal(
        "fetch",
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = api.socketTicket({
        params: owner,
        body: { channelId: "general" },
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      current = false;
      finish(
        Response.json({
          kind: "socket_ticket",
          ticket: "ticket",
          expiresAt: 10,
          leaseExpiresAt: 20,
        }),
      );
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(succeeded).not.toHaveBeenCalled();
    } finally {
      end();
    }
  });

  it("keeps the instance public while private resource requests require an online account", async () => {
    const { access } = fixture();
    access.start(false);
    const end = transport.installRequestAccess(access.transport);
    const fetcher = vi.fn(async (request: Request, init: RequestInit) => {
      expect(
        new Request(request, init).headers.has(EXPECTED_ACCOUNT_HEADER),
      ).toBe(false);
      return Response.json({ name: "Example", hasIcon: false });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await api.instance()).toEqual({ name: "Example", hasIcon: false });
      await expect(api.resource({ params: owner })).rejects.toMatchObject({
        code: "offline",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      end();
      access.stop();
    }
  });

  it("preserves account and owner Query retirement prefixes", () => {
    const client = new QueryClient();
    const a = resourceOptions("account-a", owner).queryKey;
    const b = resourceOptions("account-b", owner).queryKey;
    client.setQueryData(a, null);
    client.setQueryData(b, null);
    client.removeQueries({ queryKey: transport.privateKey("account-a") });
    expect(client.getQueryData(a)).toBeUndefined();
    expect(client.getQueryData(b)).toBeNull();
    client.clear();
  });
});
