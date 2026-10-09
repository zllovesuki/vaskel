import { readHttpFailure } from "@tests/helpers/http";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { HealthResponseSchema } from "@vaskel/contracts/health";
import { createHttpApp } from "@/server/http";

describe("actual Worker HTTP contracts", () => {
  it("preserves Hono's CF-Ray request ID in error response headers", async () => {
    const ray = "9a1234567890abcd-SJC";
    const response = await exports.default.fetch(
      new Request("https://vaskel.test/api/missing", {
        headers: { "CF-Ray": ray, "X-Request-ID": "unrelated-client-id" },
      }),
    );
    expect(await readHttpFailure(response)).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(response.headers.get("X-Request-ID")).toBe(ray);
  });
  it("produces the shared liveness schema through the Worker entry point", async () => {
    const response = await exports.default.fetch(
      new Request("https://vaskel.test/api/health"),
    );
    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
      tag: env.CF_VERSION_METADATA.tag || null,
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it.each(["754080e", "release-1", ""])(
    "exposes the configured version tag without requiring storage: %s",
    async (tag) => {
      const response = await createHttpApp().request(
        "https://vaskel.test/api/health",
        undefined,
        { CF_VERSION_METADATA: { ...env.CF_VERSION_METADATA, tag } },
      );
      expect(response.status).toBe(200);
      expect(HealthResponseSchema.parse(await response.json())).toEqual({
        status: "ok",
        tag: tag || null,
      });
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    },
  );

  it("returns a contracted JSON 404 for unknown API routes, not the SPA", async () => {
    const response = await exports.default.fetch(
      new Request("https://vaskel.test/api/missing"),
    );
    expect(response.status).toBe(404);
    const error = await readHttpFailure(response);
    expect(error.code).toBe("NOT_FOUND");
    expect(response.headers.get("X-Request-ID")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it.each([false, true])(
    "keeps failures private and correlated when the log sink throws: %s",
    async (sinkThrows) => {
      const app = createHttpApp();
      app.get("/api/failure/:id", () => {
        throw new TypeError("private content");
      });
      const logger = vi.spyOn(console, "error").mockImplementation(() => {
        if (sinkThrows) throw new Error("sink down");
      });
      try {
        const response = await app.request(
          "https://vaskel.test/api/failure/private-id?token=private-token",
        );
        expect(response.status).toBe(500);
        const body = await readHttpFailure(response);
        expect(body.code).toBe("INTERNAL_SERVER_ERROR");
        const requestId = response.headers.get("X-Request-ID");
        expect(requestId).toBeTruthy();
        expect(logger).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId,
            route: "/api/failure/:id",
          }),
        );
        expect(JSON.stringify([body, logger.mock.calls])).not.toContain(
          "private",
        );
      } finally {
        logger.mockRestore();
      }
    },
  );
});
