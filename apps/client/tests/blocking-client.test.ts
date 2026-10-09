import { failureResponse, fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BlockStatus, SetBlock } from "@vaskel/contracts/blocking";
import type { OwnerScope } from "@vaskel/contracts/messaging";

let blocks: typeof import("@/client/api/blocks");
let api: typeof import("@/client/api/client");
let commitBlock: typeof import("@/client/features/blocking/commit-block").commitBlock;
let handleTimelineMutationFailure: typeof import("@/client/features/chat/mutation-failure").handleTimelineMutationFailure;
let client: QueryClient;
const origin = "https://vaskel.test";
const userId = "11111111-1111-4111-8111-111111111111";
const otherAccount = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const status: BlockStatus = {
  targetId,
  conversationId,
  blocked: false,
  revision: 0,
  canSend: true,
};
const command: SetBlock = {
  commandId: "55555555-5555-4555-8555-555555555555",
  issuedAt: 100,
  blocked: true,
  expectedRevision: 0,
};

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin } });
  blocks = await import("@/client/api/blocks");
  api = await import("@/client/api/client");
  ({ commitBlock } = await import("@/client/features/blocking/commit-block"));
  ({ handleTimelineMutationFailure } =
    await import("@/client/features/chat/mutation-failure"));
});
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account block queries and commits", () => {
  it("normalizes participant lookups while preserving partial owner failures and account isolation", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = (await fetchRequest(input, init).json()) as {
          targetIds: string[];
        };
        expect(body.targetIds).toEqual([otherAccount, targetId]);
        return Response.json({
          kind: "block_statuses",
          statuses: [status],
          partial: true,
          unavailableTargetIds: [otherAccount],
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const first = new QueryObserver(client, {
      ...blocks.roomBlockOptions(userId, [
        targetId,
        userId,
        otherAccount,
        targetId,
      ]),
      staleTime: Infinity,
    });
    const unsubscribe = first.subscribe(() => {});
    await first.refetch();
    const second = new QueryObserver(client, {
      ...blocks.roomBlockOptions(userId, [otherAccount, targetId]),
      staleTime: Infinity,
    });
    const stopSecond = second.subscribe(() => {});
    expect(second.getCurrentResult().data).toEqual({
      kind: "block_statuses",
      statuses: [status],
      partial: true,
      unavailableTargetIds: [otherAccount],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      client.getQueryData(
        blocks.roomBlockOptions("another-account", [otherAccount, targetId])
          .queryKey,
      ),
    ).toBeUndefined();
    unsubscribe();
    stopSecond();
  });

  it("keeps unavailable owners visible in paged results instead of declaring the list empty", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      Response.json({
        kind: "blocks",
        blocks: [],
        partial: true,
        unavailableTargetIds: [targetId],
        nextCursor: targetId,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const data = await client.fetchInfiniteQuery(
      blocks.blockedPeopleOptions(userId),
    );
    expect(data.pages[0]).toMatchObject({
      blocks: [],
      partial: true,
      unavailableTargetIds: [targetId],
      nextCursor: targetId,
    });
  });

  it("waits for owner commit, retries an identical command and uses current status instead of the old receipt", async () => {
    const gate = deferred<Response>();
    const current = { ...status, blocked: false, revision: 2, canSend: true };
    const receipt = { targetId, conversationId, blocked: true, revision: 1 };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockImplementationOnce(() => gate.promise);
    vi.stubGlobal("fetch", fetch);
    client.setQueryData(
      blocks.blockStatusOptions(userId, targetId).queryKey,
      status,
    );
    const signal = new AbortController().signal;
    await expect(
      commitBlock(client, userId, targetId, command, signal),
    ).rejects.toMatchObject({ failure: "network" });
    const pending = commitBlock(client, userId, targetId, command, signal);
    expect(
      client.getQueryData(blocks.blockStatusOptions(userId, targetId).queryKey),
    ).toEqual(status);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const requests = fetch.mock.calls.map((call) =>
      fetchRequest(call[0] as Request, call[1] as RequestInit),
    );
    expect(await requests[0]!.json()).toEqual(await requests[1]!.json());
    expect(requests[0]!.method).toBe("PUT");
    gate.resolve(
      Response.json({ kind: "block_updated", receipt, status: current }),
    );
    await expect(pending).resolves.toEqual(current);
    expect(
      client.getQueryData(blocks.blockStatusOptions(userId, targetId).queryKey),
    ).toEqual(current);
  });

  it("rejects a stale revision without changing the cache and ignores a late commit after account teardown", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          failureResponse(
            { kind: "stale_revision", currentRevision: 3 },
            { status: 409 },
          ),
        )
        .mockImplementationOnce(() => gate.promise),
    );
    const key = blocks.blockStatusOptions(userId, targetId).queryKey;
    client.setQueryData(key, status);
    const abort = new AbortController();
    await expect(
      commitBlock(client, userId, targetId, command, abort.signal),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(client.getQueryData(key)).toEqual(status);
    const late = commitBlock(client, userId, targetId, command, abort.signal);
    const rejected = expect(late).rejects.toThrow();
    abort.abort();
    client.removeQueries({ queryKey: api.privateKey(userId) });
    const otherKey = blocks.blockStatusOptions(otherAccount, targetId).queryKey;
    client.setQueryData(otherKey, status);
    gate.resolve(
      Response.json({
        kind: "block_updated",
        receipt: { targetId, conversationId, blocked: true, revision: 1 },
        status: { ...status, blocked: true, revision: 1, canSend: false },
      }),
    );
    await rejected;
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(otherKey)).toEqual(status);
  });

  it("cancels reads from before a block commit so their delayed answer cannot restore old state", async () => {
    const oldRead = deferred<Response>();
    const updated = { ...status, blocked: true, revision: 1, canSend: false };
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValueOnce(
        Response.json({
          kind: "block_updated",
          receipt: { targetId, conversationId, blocked: true, revision: 1 },
          status: updated,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const options = blocks.blockStatusOptions(userId, targetId);
    const reading = client.fetchQuery(options);
    const rejected = expect(reading).rejects.toThrow();
    await commitBlock(
      client,
      userId,
      targetId,
      command,
      new AbortController().signal,
    );
    await rejected;
    oldRead.resolve(Response.json({ kind: "block_status", status }));
    await Promise.resolve();
    expect(client.getQueryData(options.queryKey)).toEqual(updated);
  });
});

describe("blocked direct sends", () => {
  it("preserves timeline, search, attachment descriptors and private read state while refreshing only block status", () => {
    const scope: OwnerScope = { kind: "conversation", id: conversationId };
    const key = [
      ...api.privateKey(userId),
      "timeline",
      scope.kind,
      scope.id,
      "general",
    ];
    const searchKey = [
      ...api.privateKey(userId),
      "search",
      scope.kind,
      scope.id,
      "general",
      "history",
    ];
    const message = {
      id: "message",
      body: "retained history",
      attachments: [{ fileId: "private-file" }],
    };
    const timeline = {
      messages: [message],
      readSequence: 8,
      cursor: { generation: 1, sequence: 9 },
      nextBefore: null,
    };
    client.setQueryData(key, timeline);
    client.setQueryData(searchKey, { kind: "matches", messages: [message] });
    const deny = vi.fn();
    const reconcile = vi.fn();
    const options = { client, userId, deny, reconcile };
    const invalidate = vi.spyOn(client, "invalidateQueries");
    handleTimelineMutationFailure(new api.ApiError("dm_blocked"), options);
    expect(client.getQueryData(key)).toEqual(timeline);
    expect(client.getQueryData(searchKey)).toEqual({
      kind: "matches",
      messages: [message],
    });
    expect(deny).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: blocks.blockKey(userId),
    });
    // A denial closes the local view; the access coordinator owns its purge.
    handleTimelineMutationFailure(new api.ApiError("forbidden"), options);
    expect(deny).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "forbidden" }),
    );
  });
});
