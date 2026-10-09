import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  createDirectorySession,
  directoryDatabase,
  validateD1Bookmark,
} from "@/server/directory/database";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";
import { applicationHarness } from "@tests/helpers/application-harness";

describe("native D1 sessions through the selected Kysely dialect", () => {
  it("writes through a primary session and resumes navigation from its bookmark", async () => {
    const primary = createDirectorySession(env, undefined, true);
    await primary.session
      .prepare(
        "INSERT INTO identity_user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .bind(
        "session-user",
        "Session User",
        "session@example.invalid",
        "2026-09-16T00:00:00Z",
        "2026-09-16T00:00:00Z",
      )
      .run();
    await primary.database
      .insertInto("resource_directory")
      .values({
        id: "session-server",
        kind: "server",
        name: "Session navigation",
        creator_id: "session-user",
        lifecycle: "ready",
        payload_hash: "session-payload",
        created_at: 1,
      })
      .execute();
    const bookmark = primary.session.getBookmark();
    expect(bookmark).not.toBeNull();
    expect(validateD1Bookmark(bookmark)).toBe(bookmark);

    const read = createDirectorySession(env, bookmark ?? undefined);
    const row = await read.database
      .selectFrom("resource_directory")
      .select(["id", "name"])
      .where("id", "=", "session-server")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      id: "session-server",
      name: "Session navigation",
    });
    expect(read.session.getBookmark()).not.toBeNull();

    const defaultPrimary = await directoryDatabase(env)
      .selectFrom("resource_directory")
      .select("id")
      .where("id", "=", "session-server")
      .executeTakeFirstOrThrow();
    expect(defaultPrimary.id).toBe("session-server");
  });

  it("preserves rollback in native session batches of compiled Kysely queries", async () => {
    const session = env.IDENTITY_DB.withSession("first-primary");
    const database = createD1Database<{
      session_batch_probe: { id: string; value: string };
    }>(session);
    await database.schema
      .createTable("session_batch_probe")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("value", "text", (column) => column.notNull())
      .execute();
    const insert = (id: string, value: string) =>
      prepareD1Query(
        session,
        database
          .insertInto("session_batch_probe")
          .values({ id, value })
          .compile(),
      );

    await expect(
      session.batch([
        insert("duplicate", "first"),
        insert("duplicate", "second"),
      ]),
    ).rejects.toThrow();
    expect(
      await database.selectFrom("session_batch_probe").selectAll().execute(),
    ).toEqual([]);

    await session.batch([insert("one", "first"), insert("two", "second")]);
    expect(
      await database
        .selectFrom("session_batch_probe")
        .selectAll()
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "one", value: "first" },
      { id: "two", value: "second" },
    ]);
    expect(session.getBookmark()).not.toBeNull();
  });

  it("selects directory read sessions on the server regardless of the supplied bookmark", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const withSession = vi.spyOn(env.IDENTITY_DB, "withSession");
    try {
      const server = await h.createServer(operator);
      expect(withSession).toHaveBeenCalledWith("first-primary");
      const bookmark = server.response.headers.get("X-Vaskel-D1-Bookmark");
      expect(bookmark).not.toBeNull();
      if (!bookmark) throw new Error("Creation must return its bookmark");

      withSession.mockClear();
      const directory = await operator.request("/api/directory", undefined, {
        bookmark,
      });
      expect(directory.status).toBe(200);
      expect(withSession).toHaveBeenCalledWith(bookmark);
      expect(await directory.json()).toMatchObject({
        resources: [expect.objectContaining({ owner: server.owner })],
      });

      withSession.mockClear();
      const blocks = await operator.request("/api/account/blocks", undefined, {
        bookmark,
      });
      expect(blocks.status).toBe(200);
      expect(withSession).toHaveBeenCalledWith("first-primary");
      expect(withSession).not.toHaveBeenCalledWith(bookmark);
    } finally {
      withSession.mockRestore();
    }
  });
});

describe("bounded opaque D1 bookmark metadata", () => {
  it("preserves printable ASCII without interpreting a platform token format", () => {
    for (const value of ["opaque-v2:ABC/+=", "a".repeat(256), "opaque token"])
      expect(validateD1Bookmark(value)).toBe(value);
    for (const value of [
      undefined,
      null,
      "",
      " ",
      "a".repeat(257),
      "token\n",
      "token\u0000",
      "token\u007F",
      "非ASCII",
    ]) {
      expect(validateD1Bookmark(value)).toBeUndefined();
    }
  });
});
