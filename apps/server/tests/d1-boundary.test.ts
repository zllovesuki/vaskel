import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";

interface DirectoryProbe {
  probe_accounts: { id: string; email: string };
  probe_directory: {
    id: string;
    owner_account_id: string;
    lifecycle: "pending" | "ready";
  };
}

describe("native D1 batches with Kysely compilation and the selected D1 dialect", () => {
  it("commits known identity/directory statements and reads them through the D1 dialect", async () => {
    const database = createD1Database<DirectoryProbe>(env.IDENTITY_DB);
    const statements = [
      database
        .insertInto("probe_accounts")
        .values({ id: "account-a", email: "a@example.invalid" })
        .compile(),
      database
        .insertInto("probe_directory")
        .values({
          id: "server-a",
          owner_account_id: "account-a",
          lifecycle: "pending",
        })
        .compile(),
    ];
    const result = await env.IDENTITY_DB.batch(
      statements.map((query) => prepareD1Query(env.IDENTITY_DB, query)),
    );
    expect(result.every((statement) => statement.success)).toBe(true);
    expect(
      await database.selectFrom("probe_accounts").selectAll().execute(),
    ).toEqual([{ id: "account-a", email: "a@example.invalid" }]);
    expect(
      await database.selectFrom("probe_directory").selectAll().execute(),
    ).toEqual([
      { id: "server-a", owner_account_id: "account-a", lifecycle: "pending" },
    ]);
  });

  it("rolls back earlier inserts when a later statement violates an actual SQL constraint", async () => {
    const database = createD1Database<DirectoryProbe>(env.IDENTITY_DB);
    await database
      .insertInto("probe_accounts")
      .values({ id: "existing", email: "existing@example.invalid" })
      .execute();
    const statements = [
      database
        .insertInto("probe_accounts")
        .values({ id: "account-a", email: "a@example.invalid" })
        .compile(),
      database
        .insertInto("probe_directory")
        .values({
          id: "server-a",
          owner_account_id: "account-a",
          lifecycle: "pending",
        })
        .compile(),
      database
        .insertInto("probe_accounts")
        .values({ id: "account-b", email: "existing@example.invalid" })
        .compile(),
    ];
    await expect(
      env.IDENTITY_DB.batch(
        statements.map((query) => prepareD1Query(env.IDENTITY_DB, query)),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(
      await database.selectFrom("probe_accounts").selectAll().execute(),
    ).toEqual([{ id: "existing", email: "existing@example.invalid" }]);
    expect(
      await database.selectFrom("probe_directory").selectAll().execute(),
    ).toEqual([]);
  });

  it("refuses an unsupported interactive Kysely transaction before its callback runs", async () => {
    const database = createD1Database<DirectoryProbe>(env.IDENTITY_DB);
    let entered = false;
    await expect(
      database.transaction().execute(async () => {
        entered = true;
      }),
    ).rejects.toThrow(/transaction/i);
    expect(entered).toBe(false);
  });
});
