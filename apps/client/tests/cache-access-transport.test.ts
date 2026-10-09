import { assertKind, failureResponse } from "@tests/helpers/http";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IdentityMeResponseSchema } from "@vaskel/contracts/identity";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import { QueryClient } from "@tanstack/react-query";
import { MediaError } from "@/client/features/media/protocol";
import {
  latestTimeline,
  type Timeline,
} from "@/client/features/chat/reconcile";

let api: typeof import("@/client/api/client");
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  api = await import("@/client/api/client");
});
afterAll(() => vi.unstubAllGlobals());

describe("access transport boundaries", () => {
  it("reports successful request start and lifetime only after decoding and final acceptance", async () => {
    let current = true;
    const lifetime = { current: () => current, accountId: "account-a" };
    const succeeded = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => lifetime,
      failed: vi.fn(),
      succeeded,
    });
    const fetcher = vi.fn(async () =>
      Response.json({ kind: "read_updated", sequence: 1 }),
    );
    vi.stubGlobal("fetch", fetcher);
    vi.useFakeTimers();
    const startedAt = Date.now();
    try {
      await api.requestWithInit(
        "/api/account/preferences",
        z.strictObject({
          kind: z.literal("read_updated"),
          sequence: z.number(),
        }),
        { method: "GET" },
        { authority: "account" },
      );
      expect(succeeded).toHaveBeenCalledExactlyOnceWith(
        "/api/account/preferences",
        startedAt,
        lifetime,
        { authority: "account" },
      );
      succeeded.mockClear();
      await expect(
        api.requestWithInit(
          "/api/account/preferences",
          z
            .strictObject({
              kind: z.literal("read_updated"),
              sequence: z.number(),
            })
            .transform((value) => {
              current = false;
              return value;
            }),
          { method: "GET" },
          { authority: "account" },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(succeeded).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 404])(
    "preserves HTTP %s denial with a malformed body before offline fallback could be considered",
    async (status) => {
      const failed = vi.fn();
      const cleanup = api.installRequestAccess({
        begin: () => ({
          current: () => true,
          accountId: null,
        }),
        failed,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("<html>denied</html>", { status })),
      );
      try {
        await expect(
          api.requestWithInit(
            "/api/resources/server/private/snapshot",
            MessagingOutcomeSchema,
            { method: "GET" },
            {
              authority: "resource",
              owner: { kind: "server", id: "private" },
            },
          ),
        ).rejects.toMatchObject({
          name: "ApiError",
          status,
          failure: "http",
          code:
            status === 401
              ? "unauthenticated"
              : status === 403
                ? "forbidden"
                : "not_found",
        });
        expect(failed).toHaveBeenCalledOnce();
        expect(api.isNetworkError(failed.mock.calls[0]?.[1])).toBe(false);
      } finally {
        cleanup();
      }
    },
  );

  it("reports native unauthentication as a denial", async () => {
    const failed = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: null,
      }),
      failed,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failureResponse({ status: "unauthenticated" })),
    );
    try {
      await expect(
        api.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      expect(failed).toHaveBeenCalledWith(
        "/api/identity/me",
        expect.objectContaining({ code: "unauthenticated", status: 401 }),
        { authority: "identity" },
      );
    } finally {
      cleanup();
    }
  });

  it("separates actual fetch failure from cancellation, unavailable HTTP, and invalid contracts", async () => {
    const failed = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: null,
      }),
      failed,
    });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new DOMException("Canceled", "AbortError"))
      .mockResolvedValueOnce(
        new Response("temporarily unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ unexpected: true }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        api.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({ failure: "network" });
      expect(failed).toHaveBeenCalledTimes(1);
      await expect(
        api.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(failed).toHaveBeenCalledTimes(1);
      await expect(
        api.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({ status: 503, failure: "http" });
      await expect(
        api.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({ status: 200, failure: "contract" });
      expect(failed).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });

  it("stops private dispatch at the access gate and ignores a response from a closed lifetime", async () => {
    let current = true;
    let complete!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const failed = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => current,
        accountId: null,
      }),
      failed,
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = api.requestWithInit(
      "/api/identity/me",
      IdentityMeResponseSchema,
      { method: "GET" },
      { authority: "identity" },
    );
    current = false;
    complete(failureResponse({ status: "unauthenticated" }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(failed).not.toHaveBeenCalled();
    cleanup();
    const blocked = api.installRequestAccess({
      begin: () => {
        throw new api.ApiError("offline", undefined, "blocked");
      },
      failed,
    });
    try {
      await expect(
        api.requestWithInit(
          "/api/resources/server/private/send",
          MessagingOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          {
            authority: "resource",
            owner: { kind: "server", id: "private" },
          },
        ),
      ).rejects.toMatchObject({ failure: "blocked" });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      blocked();
    }
  });

  it("keeps a valid HTTP 403 media restriction action scoped while rejecting malformed restrictions and terminal denials", async () => {
    const failed = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: null,
      }),
      failed,
    });
    const restriction = { kind: "action_restricted", restriction: "camera" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(failureResponse(restriction, { status: 403 }))
        .mockResolvedValueOnce(
          failureResponse({ kind: "action_restricted" }, { status: 403 }),
        )
        .mockResolvedValueOnce(
          failureResponse({ kind: "forbidden" }, { status: 403 }),
        )
        .mockResolvedValueOnce(failureResponse(restriction, { status: 401 }))
        .mockResolvedValueOnce(
          failureResponse({ kind: "dm_blocked" }, { status: 409 }),
        ),
    );
    try {
      await expect(
        api.requestWithInit(
          "/api/media/publish",
          MediaOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "media" },
        ),
      ).rejects.toMatchObject({ code: "action_restricted" });
      expect(failed).toHaveBeenCalledOnce();
      await expect(
        api.requestWithInit(
          "/api/media/publish",
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
      await expect(
        api.requestWithInit(
          "/api/resources/server/private/snapshot",
          MessagingOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          {
            authority: "resource",
            owner: { kind: "server", id: "private" },
          },
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
        failure: "http",
      });
      await expect(
        api.requestWithInit(
          "/api/media/publish",
          MediaOutcomeSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "media" },
        ),
      ).rejects.toMatchObject({
        code: "unauthenticated",
        status: 401,
        failure: "http",
      });
      await expect(
        api
          .requestWithInit(
            "/api/resources/conversation/dm/send",
            MessagingOutcomeSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            },
            {
              authority: "resource",
              owner: { kind: "conversation", id: "dm" },
            },
          )
          .then((result) => assertKind(result, "accepted")),
      ).rejects.toMatchObject({
        code: "dm_blocked",
        failure: "http",
      });
      expect(failed).toHaveBeenCalledTimes(5);
    } finally {
      cleanup();
    }
  });

  it("lets the timeline replace a replay gap after a real reset_required HTTP 409", async () => {
    const { connectTimeline } =
      await import("@/client/features/chat/connection");
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("window", {
      location: { origin: "https://vaskel.test" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const owner = { kind: "server" as const, id: "shared-server" };
    const cursor = {
      owner,
      channelId: "general",
      generation: crypto.randomUUID(),
      sequence: 1,
    };
    const client = new QueryClient();
    const key = [
      ...api.privateKey("account-a"),
      "timeline",
      owner.kind,
      owner.id,
      "general",
    ];
    client.setQueryData<Timeline>(
      key,
      latestTimeline({
        messages: [],
        cursor,
        nextBefore: null,
        readSequence: 0,
      }),
    );
    const replacement = { ...cursor, sequence: 20 };
    const snapshot = {
      kind: "snapshot",
      messages: [],
      cursor: replacement,
      nextBefore: null,
      readSequence: 10,
    };
    let releaseSnapshot!: (response: Response) => void;
    const heldSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        failureResponse(
          { kind: "reset_required", reason: "floor" },
          { status: 409 },
        ),
      )
      .mockReturnValueOnce(heldSnapshot)
      .mockResolvedValueOnce(
        Response.json({
          kind: "replay",
          events: [],
          cursor: replacement,
          highWater: 20,
          hasMore: false,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const failed = vi.fn();
    const denied = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: "account-a",
      }),
      failed,
    });
    const connection = connectTimeline({
      client,
      userId: "account-a",
      key,
      owner,
      channelId: "general",
      status: vi.fn(),
      onDenied: denied,
      subscribeContent: () => () => {},
    });
    try {
      const replay = connection.reconcile();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(client.getQueryData<Timeline>(key)?.cursor).toEqual(cursor);
      releaseSnapshot(Response.json(snapshot));
      await replay;
      expect(
        fetcher.mock.calls.map(
          ([path]) => new URL((path as Request).url).pathname,
        ),
      ).toEqual([
        "/api/resources/server/shared-server/replay",
        "/api/resources/server/shared-server/snapshot",
        "/api/resources/server/shared-server/replay",
      ]);
      expect(client.getQueryData<Timeline>(key)).toMatchObject({
        messages: [],
        cursor: replacement,
        nextBefore: null,
        readSequence: 10,
      });
      expect(failed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "reset_required" }),
        expect.objectContaining({ authority: "resource" }),
      );
      expect(denied).not.toHaveBeenCalled();
    } finally {
      connection.dispose();
      client.clear();
      cleanup();
    }
  });

  it("passes non-2xx media recovery, terminal and provider facts intact to the existing MediaError consumer", async () => {
    const handle = {
      room: {
        owner: { kind: "server" as const, id: "shared-server" },
        channelId: "general",
      },
      participantId: "self",
      accountGeneration: 2,
      clientId: crypto.randomUUID(),
      deviceToken: "a".repeat(64),
    };
    const outcomes = [
      [409, { kind: "recovery_required", handle, reason: "admission_failed" }],
      [409, { kind: "participation_ended", generation: 2, reason: "removed" }],
      [429, { kind: "capacity" }],
      [
        502,
        {
          kind: "provider_error",
          code: "uncertain_apply",
          retryable: true,
          uncertain: true,
        },
      ],
      [503, { kind: "unavailable" }],
    ] as const;
    const failed = vi.fn();
    const cleanup = api.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: null,
      }),
      failed,
    });
    const fetcher = vi.fn();
    for (const [status, outcome] of outcomes)
      fetcher.mockResolvedValueOnce(failureResponse(outcome, { status }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const { createMediaTransport } =
        await import("@/client/features/media/controller/transport");
      const invoke = createMediaTransport("account-a", () => true);
      for (const [, outcome] of outcomes) {
        const failure = await invoke(
          "join",
          {
            room: handle.room,
            clientId: handle.clientId,
            deviceToken: handle.deviceToken,
            expectedGeneration: 0,
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          },
          new AbortController().signal,
        ).catch((error) => error);
        expect(failure).toBeInstanceOf(MediaError);
        expect(failure).toMatchObject({ outcome });
      }
      expect(fetcher).toHaveBeenCalledTimes(outcomes.length);
    } finally {
      cleanup();
    }
  });
});
