import { failureResponse } from "@tests/helpers/http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
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

let peopleByIdOptions: typeof import("@/client/api/people").peopleByIdOptions;
let useDisplayNames: typeof import("@/client/api/people").useDisplayNames;
let privateKey: typeof import("@/client/api/client").privateKey;
let client: QueryClient;
const origin = "https://vaskel.test";
const profiles = Array.from({ length: 81 }, (_, index) => ({
  userId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  displayName: `Person ${index}`,
}));
const account = "account-a";
// The signed-in account is one of the listed people; its session name differs
// from the directory's so the two sources can be told apart.
const viewer = vi.hoisted(() => ({
  user: {
    userId: "00000000-0000-4000-8000-000000000001",
    displayName: "Person 1, as signed in",
  },
  online: true,
}));
vi.mock("@/client/features/auth/session-state", () => ({
  useUser: () => viewer.user,
}));
vi.mock("@/client/features/cache/access/context", () => ({
  useAccess: () => ({ canUseNetwork: viewer.online }),
}));

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin } });
  ({ peopleByIdOptions, useDisplayNames } =
    await import("@/client/api/people"));
  ({ privateKey } = await import("@/client/api/client"));
});

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
});

afterEach(() => {
  client.clear();
  viewer.online = true;
  vi.unstubAllGlobals();
});

/** One render of the hook; the cache alone answers, as it does before any read completes. */
function displayNames(
  ids: string[],
  options?: Parameters<typeof useDisplayNames>[1],
) {
  let result!: ReturnType<typeof useDisplayNames>;
  function Probe() {
    result = useDisplayNames(ids, options);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Probe)),
  );
  const query = client
    .getQueryCache()
    .find({ queryKey: peopleByIdOptions(viewer.user.userId, ids).queryKey });
  const built = query?.options as { enabled?: boolean } | undefined;
  return { ...result, enabled: built?.enabled };
}

function peopleFetch() {
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    const ids = new URL(
      path instanceof Request ? path.url : String(path),
      origin,
    ).searchParams
      .get("ids")!
      .split(",");
    if (ids.length > 40)
      return failureResponse({ kind: "invalid_input" }, { status: 400 });
    return Response.json({
      kind: "people",
      people: profiles.filter((person) => ids.includes(person.userId)),
      partial: false,
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("shared people queries", () => {
  it("reuses chat profiles in call participants and preserves the array on refetch", async () => {
    const fetch = peopleFetch();
    const ids = profiles.slice(0, 2).map((person) => person.userId);
    // An envelope left by the previous call query must not enter this cache.
    client.setQueryData([...privateKey(account), "people", ids], {
      kind: "people",
      people: profiles.slice(0, 2),
      partial: false,
    });
    const chat = new QueryObserver(
      client,
      peopleByIdOptions(account, [ids[1]!, ids[0]!, ids[1]!]),
    );
    const stopChat = chat.subscribe(() => {});
    await chat.refetch();
    const call = new QueryObserver(client, peopleByIdOptions(account, ids));
    const stopCall = call.subscribe(() => {});
    expect(call.getCurrentResult().data).toEqual(profiles.slice(0, 2));
    expect(fetch).toHaveBeenCalledTimes(1);
    const renamed = profiles.slice(0, 2).map((person) => ({
      ...person,
      displayName: `${person.displayName} renamed`,
    }));
    fetch.mockResolvedValueOnce(
      Response.json({ kind: "people", people: renamed, partial: false }),
    );
    await call.refetch();
    expect(chat.getCurrentResult().data).toEqual(renamed);
    expect(fetch).toHaveBeenCalledTimes(2);
    stopCall();
    stopChat();

    await client.fetchQuery(peopleByIdOptions("account-b", ids));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("loads every author beyond the endpoint limit without duplicate IDs", async () => {
    const fetch = peopleFetch();
    const ids = profiles.map((person) => person.userId);
    const data = await client.fetchQuery(
      peopleByIdOptions(account, [...ids.toReversed(), ...ids]),
    );
    expect(data).toEqual(profiles);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a failed batch without replacing a complete cached result", async () => {
    const fetch = peopleFetch();
    const options = peopleByIdOptions(
      account,
      profiles.map((person) => person.userId),
    );
    await client.fetchQuery(options);
    fetch.mockResolvedValueOnce(
      failureResponse({ kind: "forbidden" }, { status: 403 }),
    );
    await expect(
      client.fetchQuery({ ...options, staleTime: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(client.getQueryData(options.queryKey)).toEqual(profiles);
  });

  it("aborts every pending batch when the query is cancelled", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init: RequestInit) => {
        const signal = init.signal!;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    );
    const options = peopleByIdOptions(
      account,
      profiles.map((person) => person.userId),
    );
    const pending = client.fetchQuery(options);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    await client.cancelQueries({ queryKey: options.queryKey });
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  });
});

describe("display names", () => {
  const [other, self] = [profiles[0]!, profiles[1]!];

  it("names people from the shared cache in any order and the viewer from the session", () => {
    client.setQueryData(
      peopleByIdOptions(viewer.user.userId, [other.userId, self.userId])
        .queryKey,
      [other, self],
    );
    const named = displayNames([self.userId, other.userId, self.userId], {
      includeViewer: true,
    });
    expect([...named.names]).toEqual([
      [other.userId, "Person 0"],
      [self.userId, "Person 1, as signed in"],
    ]);
    expect(named.isPending).toBe(false);
    expect(named.enabled).toBe(true);
    // Without the viewer option the directory's name stands.
    expect(
      displayNames([other.userId, self.userId]).names.get(self.userId),
    ).toBe("Person 1");
    // The viewer is named before any read completes.
    const cold = displayNames([profiles[2]!.userId], { includeViewer: true });
    expect([...cold.names]).toEqual([[self.userId, "Person 1, as signed in"]]);
    expect(cold.isPending).toBe(true);
  });

  it("holds the read while the network is unusable or the caller says so, keeping the last names", () => {
    client.setQueryData(
      peopleByIdOptions(viewer.user.userId, [other.userId]).queryKey,
      [other],
    );
    viewer.online = false;
    const offline = displayNames([other.userId]);
    expect(offline.names.get(other.userId)).toBe("Person 0");
    expect(offline.enabled).toBe(false);
    viewer.online = true;
    expect(displayNames([other.userId], { enabled: false }).enabled).toBe(
      false,
    );
    expect(displayNames([]).enabled).toBe(false);
    expect(displayNames([other.userId]).enabled).toBe(true);
  });
});
