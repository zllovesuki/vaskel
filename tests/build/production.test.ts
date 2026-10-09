import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { fixtureAuthVars } from "@tests/config/bindings.ts";
import { apiErrors } from "@vaskel/contracts/api";
import { HealthResponseSchema } from "@vaskel/contracts/health";
import { SURFACES } from "@vaskel/ui/brand";

describe("production build with deployment compatibility flags", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = createTestHarness({
    root,
    workers: [
      {
        configPath: "./apps/client/dist/vaskel/wrangler.json",
        vars: fixtureAuthVars,
        secrets: fixtureAuthVars,
      },
    ],
  });
  afterAll(async () => {
    await server.close();
  });
  beforeAll(async () => {
    await server.listen();
  }, 30_000);

  it("serves the compiled client and its referenced assets", async () => {
    const response = await server.fetch("/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /default-src 'self'/,
    );
    const permissions = response.headers.get("Permissions-Policy") ?? "";
    assert.match(permissions, /camera=\(self\)/);
    assert.match(permissions, /microphone=\(self\)/);
    assert.match(permissions, /display-capture=\(self\)/);
    const html = await response.text();
    assert.match(html, /<title>vaskel\.<\/title>/);
    const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.ok(
      paths.length >= 2,
      "client HTML must reference compiled JavaScript and CSS",
    );
    for (const path of paths) {
      assert.ok(path);
      const asset = await server.fetch(path);
      assert.equal(asset.status, 200, `compiled asset ${path} must be served`);
    }
  });

  it("serves the brand master at its stable paths outside the offline shell", async () => {
    const master = new URL("../../packages/ui/brand/", import.meta.url);
    for (const path of SURFACES.app) {
      const response = await server.fetch(`/${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(
        response.headers.get("Cache-Control"),
        "public, max-age=86400",
        path,
      );
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        new Uint8Array(await readFile(new URL(path, master))),
        `${path} must be the committed master`,
      );
    }
    const worker = await readFile(
      new URL("../../apps/client/dist/client/sw.js", import.meta.url),
      "utf8",
    );
    const entries = /\.precache\((\[[\s\S]*?\])\)/u.exec(worker)?.[1];
    assert.ok(entries, "the built worker must install its precache manifest");
    const precached = (JSON.parse(entries) as { url: string }[]).map(
      (entry) => entry.url,
    );
    // Notification display references brand icons without adding them to the shell.
    for (const path of SURFACES.app)
      assert.ok(!precached.includes(`/${path}`), path);
  });

  it("produces the executable health contract", async () => {
    const response = await server.fetch("/api/health");
    const environment = await server
      .getWorker<{ CF_VERSION_METADATA: { tag: string } }>()
      .getEnv();
    assert.equal(response.status, 200);
    assert.deepEqual(HealthResponseSchema.parse(await response.json()), {
      status: "ok",
      tag: environment.CF_VERSION_METADATA.tag || null,
    });
    assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  });

  it("serves the compiled service worker with revalidation", async () => {
    const response = await server.fetch("/sw.js");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /javascript/);
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
    assert.equal(
      await response.text(),
      await readFile(
        new URL("../../apps/client/dist/client/sw.js", import.meta.url),
        "utf8",
      ),
    );
  });

  it("serves direct application paths through the production asset fallback", async () => {
    for (const path of [
      "/sign-in",
      "/settings/account",
      "/settings/notifications",
      "/search?q=shared%20phrase",
      "/invite?token=synthetic-link",
      "/servers/11111111-1111-4111-8111-111111111111/channels/22222222-2222-4222-8222-222222222222",
      "/conversations/33333333-3333-4333-8333-333333333333",
    ]) {
      const response = await server.fetch(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
      const html = await response.text();
      assert.match(html, /<title>vaskel\.<\/title>/);
      assert.match(html, /src="\/assets\/[^"]+\.js"/);
    }
  });

  it("unknown APIs and fixture paths return contracted errors", async () => {
    for (const path of [
      "/api",
      "/api/missing",
      "/api/test-failure",
      "/api/database-probe",
    ]) {
      const response = await server.fetch(path);
      assert.equal(response.status, 404, path);
      assert.match(
        response.headers.get("Content-Type") ?? "",
        /application\/json/,
      );
      assert.deepEqual(await response.json(), {
        defined: true,
        code: "NOT_FOUND",
        status: apiErrors.NOT_FOUND.status,
        message: "Not Found",
      });
      assert.ok(response.headers.get("X-Request-ID"));
    }
  });

  it("excludes probe code and test-only bindings", async () => {
    const environment = await server
      .getWorker<Record<string, unknown>>()
      .getEnv();
    assert.ok("IDENTITY_DB" in environment);
    assert.ok("ASSETS" in environment);
    assert.ok("SERVER_DO" in environment);
    assert.ok("CONVERSATION_DO" in environment);
    assert.ok("MEDIA_ROOM" in environment);
    assert.ok("ACCOUNT_MEDIA" in environment);
    assert.ok("NOTIFICATION_DO" in environment);
    assert.ok("PUSH_QUEUE" in environment);
    assert.ok("EMAIL" in environment);
    assert.ok(!("DATABASE_PROBE" in environment));
    assert.ok(!("TEST_MIGRATIONS" in environment));
    const bundle = await readFile(
      new URL("../../apps/client/dist/vaskel/index.js", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      bundle,
      /DatabaseProbeDO|DATABASE_PROBE|tests\/fixtures/,
    );
  });
});
