import { fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import {
  InfiniteQueryObserver,
  QueryClient,
  focusManager,
} from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SearchPage } from "@/client/api/search";
import type { CrossSearchHit } from "@vaskel/contracts/search";
import { observeSearchForeground } from "@/client/features/search/foreground";

let query: typeof import("@/client/features/search/query");
let invalidation: typeof import("@/client/features/search/invalidate");
let transport: typeof import("@/client/api/search");
let api: typeof import("@/client/api/client");
let client: QueryClient;
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const account = id(1);
const server = id(2);
const secondServer = id(3);
const fence = {
  capture: () => "current",
  current: (token: string) => token === "current",
};
function hit(serverId = server, value = 1): CrossSearchHit {
  return {
    serverId,
    serverName: `Server ${serverId}`,
    channel: {
      id: id(4),
      name: "general",
    },
    message: {
      id: id(value + 10),
      channelId: id(4),
      authorId: id(5),
      body: "秘密のメッセージ",
      attachments: [{ fileId: id(6), filename: "非公開.txt", byteLength: 3 }],
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      reactions: [],
      mentions: [],
      createdSequence: value,
      updatedSequence: value,
      version: 1,
    },
  };
}
function page(
  hits = [hit()],
  cursor: string | null = null,
  deniedServerIds: string[] = [],
): SearchPage {
  return {
    kind: "cross_matches",
    hits,
    deniedServerIds,
    unavailableServerIds: [],
    coverage: { limited: false, unavailable: false },
    nextCursor: cursor,
  };
}

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  query = await import("@/client/features/search/query");
  invalidation = await import("@/client/features/search/invalidate");
  transport = await import("@/client/api/search");
  api = await import("@/client/api/client");
});
beforeEach(() => {
  client = new QueryClient();
});
afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
});

describe("online cross-server search", () => {
  it("restarts once without a cursor when loaded search pages return to the foreground", async () => {
    const gate = deferred<Response>();
    const fetch = vi
      .fn(async (_path: string, _init: RequestInit) => gate.promise)
      .mockResolvedValueOnce(Response.json(page([hit(server, 1)], "next")))
      .mockResolvedValueOnce(Response.json(page([hit(server, 2)], "last")))
      .mockResolvedValueOnce(Response.json(page([hit(server, 3)])));
    vi.stubGlobal("fetch", fetch);
    const options = query.crossSearchOptions(
      account,
      { q: "秘密の" },
      0,
      fence,
    );
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);

    const windowTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
      hasFocus: () => true,
    });
    let epoch = 0;
    const restart = vi.fn(() => {
      epoch++;
      invalidation.invalidateCrossSearch(client, account);
      observer.setOptions(
        query.crossSearchOptions(account, { q: "秘密の" }, epoch, fence),
      );
    });
    const unmount = observeSearchForeground(
      restart,
      windowTarget,
      documentTarget,
    );
    windowTarget.dispatchEvent(new Event("blur"));
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(observer.getCurrentResult().data).toBeUndefined();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(
      await fetchRequest(
        fetch.mock.calls[3]![0] as RequestInfo,
        fetch.mock.calls[3]![1] as RequestInit,
      ).json(),
    ).toEqual({
      query: "秘密の",
    });
    gate.resolve(Response.json(page([hit(server, 99)], "fresh")));
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isFetching).toBe(false),
    );
    expect(observer.getCurrentResult().data).toMatchObject({
      pages: [{ hits: [{ message: { id: id(109) } }] }],
      pageParams: [null],
    });
    expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    unmount();
    windowTarget.dispatchEvent(new Event("blur"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(restart).toHaveBeenCalledTimes(1);
    stop();
  });

  it("continues through an empty partial page, bounds retained pages, and never refetches them on focus", async () => {
    const fetch = vi.fn(
      async (httpInput: RequestInfo | URL, init: RequestInit) => {
        const httpRequest = fetchRequest(httpInput, init);

        const input = (await httpRequest.json()) as { cursor?: string };
        const index = input.cursor ? Number(input.cursor) : 0;
        return Response.json({
          ...page(
            index === 1 ? [] : [hit(server, index + 1)],
            String(index + 1),
          ),
          coverage: { limited: true, unavailable: index > 0 },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    client.mount();
    const options = query.crossSearchOptions(
      account,
      { q: "秘密の" },
      0,
      fence,
    );
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    expect(observer.getCurrentResult().data?.pages.at(-1)).toMatchObject({
      hits: [],
      nextCursor: "2",
    });
    for (let index = 0; index < 4; index++) await observer.fetchNextPage();
    const result = observer.getCurrentResult().data!;
    expect(result.pages).toHaveLength(5);
    expect(result.pageParams[0]).toBe("1");
    expect(result.pages.at(-1)).toMatchObject({
      coverage: { limited: true, unavailable: true },
    });
    fetch.mockClear();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.unmount();
  });

  it("removes only known-denied owners from previously retained pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(page([hit(), hit(secondServer, 2)], "next")),
      )
      .mockResolvedValueOnce(
        Response.json(page([hit(secondServer, 3)], null, [server])),
      );
    vi.stubGlobal("fetch", fetch);
    const options = query.crossSearchOptions(
      account,
      { q: "秘密の" },
      0,
      fence,
    );
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await observer.fetchNextPage();
    expect(
      client
        .getQueryData(options.queryKey)
        ?.pages.map((page) => page.hits.map((hit) => hit.serverId)),
    ).toEqual([[secondServer], [secondServer]]);
    expect(client.getQueryData(options.queryKey)?.pageParams).toEqual([
      null,
      "next",
    ]);
    stop();
  });

  it("retains earlier bodies when a later page omits a source or reports temporary unavailability", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(page([hit(), hit(secondServer, 2)], "next")),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...page([], "later"),
          unavailableServerIds: [server],
          coverage: { limited: false, unavailable: true },
        }),
      )
      .mockResolvedValueOnce(Response.json(page([hit(secondServer, 3)])));
    vi.stubGlobal("fetch", fetch);
    const options = query.crossSearchOptions(
      account,
      { q: "秘密の" },
      0,
      fence,
    );
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    const cached = client.getQueryData(options.queryKey)!;
    expect(cached.pages[0]?.hits).toEqual([hit(), hit(secondServer, 2)]);
    expect(cached.pages.some((page) => page.coverage.unavailable)).toBe(true);
    stop();
  });

  it("cancels stale aggregates on owner invalidation while preserving other owners and continuation", async () => {
    const held = deferred<Response>();
    const fetch = vi
      .fn((_path: string, _init: RequestInit) => held.promise)
      .mockResolvedValueOnce(
        Response.json(page([hit(), hit(secondServer, 2)], "next")),
      );
    vi.stubGlobal("fetch", fetch);
    const options = query.crossSearchOptions(
      account,
      { q: "秘密の" },
      0,
      fence,
    );
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    const pending = observer.fetchNextPage();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    invalidation.invalidateCrossSearch(client, account, {
      kind: "server",
      id: server,
    });
    expect(fetch.mock.calls.at(-1)![1].signal?.aborted).toBe(true);
    expect(client.getQueryData(options.queryKey)?.pages[0]?.hits).toEqual([
      hit(secondServer, 2),
    ]);
    held.resolve(Response.json(page([hit(server, 3)])));
    await pending;
    expect(client.getQueryData(options.queryKey)?.pages).toHaveLength(1);
    expect(client.getQueryData(options.queryKey)?.pages[0]?.hits).toEqual([
      hit(secondServer, 2),
    ]);
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    stop();
  });

  it("rejects a late page after the displayed query is replaced", async () => {
    const held = deferred<Response>();
    const fetch = vi
      .fn((_path: string, _init: RequestInit) => held.promise)
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(Response.json(page([hit(secondServer, 2)])));
    vi.stubGlobal("fetch", fetch);
    const original = query.crossSearchOptions(
      account,
      { q: "old phrase" },
      0,
      fence,
    );
    const observer = new InfiniteQueryObserver(client, original);
    const stop = observer.subscribe(() => {});
    const replacement = query.crossSearchOptions(
      account,
      { q: "new phrase" },
      0,
      fence,
    );
    observer.setOptions(replacement);
    await observer.refetch();
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    held.resolve(Response.json(page([hit()])));
    await vi.waitFor(() =>
      expect(client.getQueryData(original.queryKey)).toBeUndefined(),
    );
    expect(observer.getCurrentResult().data?.pages[0]?.hits).toEqual([
      hit(secondServer, 2),
    ]);
    stop();
  });

  it("rejects delayed bodies at the content fence even if the underlying fetch ignores cancellation", async () => {
    const gate = deferred<Response>();
    let epoch = "before";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate.promise),
    );
    const pending = transport.searchServers(
      { query: "秘密の" },
      new AbortController().signal,
      { capture: () => epoch, current: (token) => token === epoch },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    epoch = "after";
    gate.resolve(Response.json(page()));
    await rejected;
  });

  it("cancels account search on invalidation without touching channel searches, timelines, or a replacement account", async () => {
    const gate = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: RequestInfo | URL, init: RequestInit) => {
        signal = init.signal;
        return gate.promise;
      }),
    );
    const options = query.crossSearchOptions(
      account,
      { q: "秘密の" },
      0,
      fence,
    );
    const localKey = [
      ...api.privateKey(account),
      "search",
      "server",
      server,
      id(4),
      "秘密の",
    ];
    const timelineKey = [
      ...api.privateKey(account),
      "timeline",
      "server",
      server,
      id(4),
    ];
    const otherKey = query.crossSearchOptions(
      id(9),
      { q: "秘密の" },
      0,
      fence,
    ).queryKey;
    client.setQueryData(localKey, { body: "channel result" });
    client.setQueryData(timelineKey, { readSequence: 0 });
    client.setQueryData(otherKey, { pages: [page()], pageParams: [null] });
    const pending = client.fetchInfiniteQuery(options);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signal).toBeDefined());
    invalidation.invalidateCrossSearch(client, account);
    expect(signal?.aborted).toBe(true);
    gate.resolve(Response.json(page()));
    await rejected;
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(client.getQueryData(localKey)).toEqual({ body: "channel result" });
    expect(client.getQueryData(timelineKey)).toEqual({ readSequence: 0 });
    expect(client.getQueryData(otherKey)).toBeDefined();
  });

  it("does not issue a request while access is offline and does not retry a failed search", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: "unavailable" } }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    const options = query.crossSearchOptions(account, { q: "秘密の" }, 0, {
      capture: () => "offline",
      current: () => false,
    });
    await expect(client.fetchInfiniteQuery(options)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.fetchInfiniteQuery(
        query.crossSearchOptions(account, { q: "秘密の" }, 1, fence),
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses code points for the query boundary and transports only server/channel filters", async () => {
    expect(query.validSearchPhrase("𠀀𠀁𠀂")).toBe(true);
    expect(query.validSearchPhrase("𠀀𠀁")).toBe(false);
    expect(query.validSearchPhrase("𠀀".repeat(257))).toBe(false);
    expect(query.searchPhraseIssue("")).toBe("short");
    expect(query.searchPhraseIssue("  do  ")).toBe("short");
    expect(query.searchPhraseIssue("door")).toBeNull();
    expect(query.searchPhraseIssue("𠀀".repeat(257))).toBe("long");
    expect(query.searchPhraseIssue(`abc${" ".repeat(1_022)}`)).toBe("long");
    const fetch = vi.fn(async (_path: string, _init: RequestInit) =>
      Response.json(page()),
    );
    vi.stubGlobal("fetch", fetch);
    await client.fetchInfiniteQuery(
      query.crossSearchOptions(
        account,
        { q: "  秘密の  ", server, channel: id(4) },
        0,
        fence,
      ),
    );
    expect(
      new URL(
        fetchRequest(fetch.mock.calls[0]![0], fetch.mock.calls[0]![1]).url,
      ).pathname,
    ).toBe("/api/account/search");
    expect(
      await fetchRequest(
        fetch.mock.calls[0]![0],
        fetch.mock.calls[0]![1] as RequestInit,
      ).json(),
    ).toEqual({ query: "秘密の", serverId: server, channelId: id(4) });
  });
});
