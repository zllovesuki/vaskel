import { assertKind, failureResponse } from "@tests/helpers/http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IdentityMeResponseSchema } from "@vaskel/contracts/identity";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";

let client: typeof import("@/client/api/client");

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "http://localhost:5177" } });
  client = await import("@/client/api/client");
});
afterAll(() => vi.unstubAllGlobals());

describe("HTTP failure decoding", () => {
  it.each([
    {
      body: JSON.stringify({
        error: { code: "internal_error", message: "private server detail" },
        requestId: "body-reference",
      }),
      header: "ray-reference",
      expected: "ray-reference",
    },
    {
      body: JSON.stringify({
        error: { code: "internal_error", message: "private server detail" },
        requestId: "body-reference",
      }),
      header: undefined,
      expected: undefined,
    },
    { body: "not JSON", header: "ray-reference", expected: "ray-reference" },
    {
      body: "not JSON",
      header: "untrusted reference text",
      expected: undefined,
    },
  ])(
    "retains safe error references across JSON and preview decoding ($expected)",
    async ({ body, header, expected }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status: 500,
              headers: header ? { "X-Request-ID": header } : {},
            }),
        ),
      );
      for (const operation of [
        () =>
          client.requestWithInit(
            "/api/identity/me",
            IdentityMeResponseSchema,
            { method: "GET" },
            { authority: "identity" },
          ),
        () =>
          client.requestStream(
            "/api/resources/server/owner/search-index",
            { method: "GET" },
            (response) => response.arrayBuffer(),
            {
              authority: "message",
              owner: { kind: "server", id: "owner" },
            },
          ),
      ]) {
        const failure = await operation().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(client.ApiError);
        expect(failure).toMatchObject({ requestId: expected, status: 500 });
        if (expected)
          expect(client.errorMessage(failure)).toEqual({
            key: "api.unknownWithReference",
            params: { requestId: expected },
          });
        expect(JSON.stringify(client.errorMessage(failure))).not.toContain(
          "private server detail",
        );
      }
    },
  );
  it.each([
    { code: "invalid_credentials", status: 401, denied: "unauthenticated" },
    { code: "email_unverified", status: 403, denied: "forbidden" },
  ])(
    "preserves public sign-in $code and HTTP $status while keeping /me denial handling",
    async ({ code, status, denied }) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(failureResponse({ status: code }, { status }))
          .mockResolvedValueOnce(
            failureResponse({ status: denied }, { status }),
          ),
      );
      await expect(
        client.requestWithInit(
          "/api/identity/sign-in",
          IdentityMeResponseSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { authority: "public" },
        ),
      ).rejects.toMatchObject({
        name: "ApiError",
        code,
        status,
        failure: "http",
      });
      await expect(
        client.requestWithInit(
          "/api/identity/me",
          IdentityMeResponseSchema,
          { method: "GET" },
          { authority: "identity" },
        ),
      ).rejects.toMatchObject({
        name: "ApiError",
        code: denied,
        status,
        failure: "http",
      });
    },
  );

  it("rejects a schema-valid authenticated sign-in body when HTTP status denies authentication", async () => {
    const body = IdentityMeResponseSchema.parse({
      status: "authenticated",
      user: {
        userId: crypto.randomUUID(),
        displayName: "River",
        email: "river@example.test",
        isOperator: false,
        expiresAt: "2030-01-01T00:00:00.000Z",
        preferences: { language: null, revision: 0 },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 401 })),
    );
    await expect(
      client.requestWithInit(
        "/api/identity/sign-in",
        IdentityMeResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        { authority: "public" },
      ),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "unauthenticated",
      status: 401,
      failure: "http",
    });
  });

  it("surfaces rejected origins before sign-in while preserving owner permission failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          failureResponse(
            { kind: "origin_rejected" },
            { status: 403, headers: { "X-Request-ID": "origin-regression" } },
          ),
        )
        .mockResolvedValueOnce(
          failureResponse({ kind: "forbidden" }, { status: 403 }),
        ),
    );
    await expect(
      client.requestWithInit(
        "/api/identity/me",
        IdentityMeResponseSchema,
        { method: "GET" },
        { authority: "identity" },
      ),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "origin_rejected",
      status: 403,
      failure: "http",
    });
    await expect(
      client
        .requestWithInit(
          "/api/resources/server/denied/snapshot",
          MessagingOutcomeSchema,
          { method: "GET" },
          {
            authority: "resource",
            owner: { kind: "server", id: "denied" },
          },
        )
        .then((result) => assertKind(result, "snapshot")),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "forbidden",
      status: 403,
      failure: "http",
    });
  });
});

describe("private byte streams", () => {
  const path = "/api/resources/server/owner/search-index";
  const scope = {
    authority: "message",
    owner: { kind: "server", id: "owner" },
  } as const;
  const consume = (response: Response) => response.arrayBuffer();

  it("fences a body that finishes after access changes and sends captured identity headers", async () => {
    let current = true;
    const failed = vi.fn();
    const release = client.installRequestAccess({
      begin: () => ({
        current: () => current,
        accountId: "original-account",
      }),
      failed,
    });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => (stream = controller),
      }),
      { headers: { "Content-Type": "application/octet-stream" } },
    );
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => response);
    vi.stubGlobal("fetch", fetch);
    try {
      const pending = client.requestStream(
        path,
        { method: "GET" },
        consume,
        scope,
      );
      await vi.waitFor(() => expect(response.bodyUsed).toBe(true));
      const init = fetch.mock.calls[0]![1];
      expect(init).toMatchObject({ credentials: "same-origin" });
      const headers = new Headers(init.headers);
      expect(headers.get("X-Vaskel-Expected-Account")).toBe("original-account");
      current = false;
      stream.enqueue(new Uint8Array([137, 80, 78, 71]));
      stream.close();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(failed).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("keeps a missing resource local while forwarding permission and session failures", async () => {
    const failed = vi.fn();
    const release = client.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: "account",
      }),
      failed,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          failureResponse({ kind: "not_found" }, { status: 404 }),
        )
        .mockResolvedValueOnce(new Response("denied", { status: 403 }))
        .mockResolvedValueOnce(
          failureResponse({ kind: "unauthenticated" }, { status: 401 }),
        ),
    );
    try {
      for (const code of ["not_found", "forbidden", "unauthenticated"]) {
        await expect(
          client.requestStream(path, { method: "GET" }, consume, scope),
        ).rejects.toMatchObject({ code });
        expect(failed).toHaveBeenLastCalledWith(
          path,
          expect.objectContaining({ code }),
          expect.objectContaining({ authority: "message" }),
        );
      }
    } finally {
      release();
    }
  });

  it("reports an interrupted binary response as a network failure", async () => {
    const failed = vi.fn();
    const release = client.installRequestAccess({
      begin: () => ({
        current: () => true,
        accountId: "account",
      }),
      failed,
    });
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection interrupted"));
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    try {
      await expect(
        client.requestStream(path, { method: "GET" }, consume, scope),
      ).rejects.toMatchObject({
        failure: "network",
      });
      expect(failed).toHaveBeenCalledWith(
        path,
        expect.objectContaining({ failure: "network" }),
        expect.objectContaining({ authority: "message" }),
      );
    } finally {
      release();
    }
  });

  it("retires a blocked binary read after access loss without reporting an obsolete network failure", async () => {
    let current = true;
    const failed = vi.fn();
    const release = client.installRequestAccess({
      begin: () => ({
        current: () => current,
        accountId: "account",
      }),
      failed,
    });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    try {
      const pending = client.requestStream(
        path,
        { method: "GET" },
        consume,
        scope,
      );
      await vi.waitFor(() => expect(response.bodyUsed).toBe(true));
      current = false;
      stream.error(new Error("old account connection failed"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(failed).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});

describe("native byte acknowledgements", () => {
  it("rejects a non-success body before granting identity freshness", async () => {
    const { rawRoutes } = await import("@vaskel/contracts/api");
    const succeeded = vi.fn();
    const release = client.installRequestAccess({
      begin: () => ({ current: () => true, accountId: "account" }),
      failed: vi.fn(),
      succeeded,
    });
    vi.stubGlobal("fetch", async () => Response.json({ kind: "forbidden" }));
    try {
      await expect(
        client.requestWithInit(
          "/file",
          rawRoutes.fileUpload.output,
          { method: "PUT", body: new Blob(["file"]) },
          { authority: "resource", owner: { kind: "server", id: "owner" } },
        ),
      ).rejects.toMatchObject({ failure: "contract", status: 200 });
      expect(succeeded).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
