import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { owner, user } from "@tests/helpers/cache-access";
import { fetchRequest } from "@tests/helpers/http";

let api: typeof import("@/client/api/contract").api;
let transport: typeof import("@/client/api/client");
let activateTransport: typeof import("@/client/api/bookmark").activateTransport;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  vi.stubGlobal("location", { origin: "https://vaskel.test" });
  ({ api } = await import("@/client/api/contract"));
  transport = await import("@/client/api/client");
  ({ activateTransport } = await import("@/client/api/bookmark"));
});
afterAll(() => vi.unstubAllGlobals());

function directoryResponse(bookmark: string) {
  return Response.json(
    {
      kind: "directory",
      resources: [],
      canCreateServers: false,
      partial: false,
      nextCursor: null,
    },
    { headers: { "X-Vaskel-D1-Bookmark": bookmark } },
  );
}

describe("account-scoped API bookmarks", () => {
  it("forwards the current bookmark through public, identity, cleanup and byte requests", async () => {
    const retire = activateTransport(user.userId);
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = fetchRequest(input, init);
        requests.push(request);
        switch (new URL(request.url).pathname) {
          case "/api/directory":
            return directoryResponse("current-bookmark");
          case "/api/instance":
            return Response.json({ name: "Example", hasIcon: false });
          case "/api/identity/me":
            return Response.json({ status: "authenticated", user });
          case "/api/identity/sign-out":
            return Response.json({ status: "signed_out" });
          default:
            return new Response("private bytes");
        }
      },
    );
    try {
      await api.directory({ query: {} });
      await api.instance();
      await api.me();
      await transport.requestStream(
        `/api/resources/server/${owner.id}/search-index`,
        { method: "GET" },
        (response) => response.text(),
        { authority: "message", owner },
      );
      await api.signOut();

      expect(
        requests.map((request) => request.headers.get("X-Vaskel-D1-Bookmark")),
      ).toEqual([
        null,
        "current-bookmark",
        "current-bookmark",
        "current-bookmark",
        "current-bookmark",
      ]);
    } finally {
      retire();
    }
  });

  it("discards late bookmarks from replaced accounts and clears them on retirement", async () => {
    const retireFirst = activateTransport(user.userId);
    let retireSecond = () => {};
    let finishFirst!: (response: Response) => void;
    const requests: Request[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = fetchRequest(input, init);
      requests.push(request);
      if (requests.length === 1)
        return new Promise<Response>((resolve) => {
          finishFirst = resolve;
        });
      if (new URL(request.url).pathname === "/api/directory")
        return Promise.resolve(directoryResponse("second-account-bookmark"));
      return Promise.resolve(
        Response.json({ name: "Example", hasIcon: false }),
      );
    });
    try {
      const pending = api.directory({ query: {} });
      await vi.waitFor(() => expect(finishFirst).toBeTypeOf("function"));
      retireFirst();
      retireSecond = activateTransport(crypto.randomUUID());
      await api.directory({ query: {} });
      finishFirst(directoryResponse("retired-account-bookmark"));
      await pending;
      await api.instance();
      retireSecond();
      await api.instance();

      expect(
        requests.map((request) => request.headers.get("X-Vaskel-D1-Bookmark")),
      ).toEqual([null, null, "second-account-bookmark", null]);
    } finally {
      retireFirst();
      retireSecond();
    }
  });
});
