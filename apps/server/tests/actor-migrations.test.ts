import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { migrateActorStorage } from "@/server/storage/actor-migrations";
import {
  initialMigrations,
  successfulMigrations,
} from "@tests/fixtures/probe-schema";

describe("actor migration diagnostics", () => {
  it.each([
    ["SERVER_DO", "message_owner"],
    ["CONVERSATION_DO", "message_owner"],
    ["MEDIA_ROOM", "media_room"],
    ["ACCOUNT_MEDIA", "account_media"],
    ["EVENT_DISPATCH", "event_dispatch"],
    ["NOTIFICATION_DO", "notification"],
  ] as const)(
    "identifies a failed %s constructor before RPC can run",
    async (binding, schema) => {
      const actor: DurableObjectStub = env[binding].getByName(
        crypto.randomUUID(),
      );
      const supportedVersion = await runInDurableObject(
        actor,
        (_instance, state) => {
          const { version } = state.storage.sql
            .exec<{ version: number }>(
              "SELECT MAX(version) AS version FROM vaskel_schema_migrations",
            )
            .one();
          state.storage.sql.exec(
            "INSERT INTO vaskel_schema_migrations(version, name) VALUES (?, ?)",
            version + 1,
            "private-stored-name",
          );
          return version;
        },
      );
      await evictDurableObject(actor);
      const logger = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(runInDurableObject(actor, () => "ready")).rejects.toThrow(
          /newer than or incompatible/,
        );
        expect(logger).toHaveBeenCalledExactlyOnceWith({
          event: "actor_migration_failed",
          actorId: actor.id.toString(),
          schema,
          phase: "validate_ledger",
          reason: "schema_ahead",
          supportedVersion,
          observedVersion: supportedVersion + 1,
          errorName: "Error",
        });
      } finally {
        logger.mockRestore();
      }
    },
  );

  it.each(["SERVER_DO", "CONVERSATION_DO"] as const)(
    "initializes %s with both history indexes in the six-section baseline",
    async (binding) => {
      const actor = env[binding].getByName(crypto.randomUUID());
      await runInDurableObject(actor, (_, state) => {
        expect(
          state.storage.sql
            .exec(
              "SELECT MAX(version) AS version FROM vaskel_schema_migrations",
            )
            .one(),
        ).toEqual({ version: 6 });
        expect(
          state.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('messages_history','messages_live_history') ORDER BY name",
            )
            .toArray(),
        ).toEqual([
          { name: "messages_history" },
          { name: "messages_live_history" },
        ]);
        const plan = state.storage.sql
          .exec(
            "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages WHERE channel_id=? AND created_sequence>? AND deleted_at IS NULL AND author_id!=?",
            "room",
            0,
            "viewer",
          )
          .toArray();
        expect(plan.map((row) => row.detail).join(" ")).toContain(
          "messages_live_history",
        );
      });
    },
  );

  it("reports a ledger-write failure after rolling back native DDL, then permits a retry", async () => {
    const actor = env.DATABASE_PROBE.getByName(crypto.randomUUID());
    await actor.append({
      actorId: "author",
      commandId: "retained",
      body: "Retained message",
    });
    const before = await actor.snapshot();
    await runInDurableObject(actor, (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER reject_ledger BEFORE INSERT ON vaskel_schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT, 'ledger failure'); END",
      );
      let columnsAtLog: unknown;
      const logger = vi.spyOn(console, "error").mockImplementation(() => {
        columnsAtLog = state.storage.sql
          .exec("PRAGMA table_info(messages)")
          .toArray()
          .map((row) => row.name);
      });
      try {
        expect(() =>
          migrateActorStorage(state.storage, successfulMigrations, {
            schema: "message_owner",
            actorId: state.id.toString(),
          }),
        ).toThrow(/ledger failure/);
        expect(logger).toHaveBeenCalledExactlyOnceWith({
          event: "actor_migration_failed",
          actorId: state.id.toString(),
          schema: "message_owner",
          phase: "write_ledger",
          supportedVersion: 2,
          migrationVersion: 2,
          migrationName: "message_revision",
          errorName: "Error",
        });
        expect(columnsAtLog).not.toContain("revision");
        expect(
          state.storage.sql
            .exec(
              "SELECT MAX(version) AS version FROM vaskel_schema_migrations",
            )
            .one(),
        ).toEqual({ version: 1 });
        expect(
          state.storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE name='messages_by_author'",
            )
            .toArray(),
        ).toEqual([]);
      } finally {
        logger.mockRestore();
      }
      state.storage.sql.exec("DROP TRIGGER reject_ledger");
    });
    expect(await actor.snapshot()).toEqual(before);
    await actor.upgrade(false);
    await runInDurableObject(actor, (_, state) => {
      expect(
        state.storage.sql
          .exec("SELECT MAX(version) AS version FROM vaskel_schema_migrations")
          .one(),
      ).toEqual({ version: 2 });
    });
  });

  it.each([
    { version: 1, reason: "name_mismatch" },
    { version: 2, reason: "ledger_gap", expectedVersion: 1 },
  ])(
    "identifies $reason without logging stored names or applying pending SQL",
    async ({ version, reason, expectedVersion }) => {
      const actor = env.DATABASE_PROBE.getByName(crypto.randomUUID());
      await runInDurableObject(actor, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE vaskel_schema_migrations SET version = ?, name = ?",
          version,
          "private-stored-name",
        );
        const logger = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(() =>
            migrateActorStorage(state.storage, successfulMigrations, {
              schema: "message_owner",
              actorId: state.id.toString(),
            }),
          ).toThrow(/newer than or incompatible/);
          expect(logger).toHaveBeenCalledExactlyOnceWith({
            event: "actor_migration_failed",
            actorId: state.id.toString(),
            schema: "message_owner",
            phase: "validate_ledger",
            reason,
            supportedVersion: 2,
            observedVersion: version,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            errorName: "Error",
          });
          expect(
            state.storage.sql
              .exec("PRAGMA table_info(messages)")
              .toArray()
              .map((row) => row.name),
          ).not.toContain("revision");
        } finally {
          logger.mockRestore();
        }
      });
    },
  );

  it.each([
    { version: 2, name: "out-of-order" },
    { version: 1, name: "" },
  ])(
    "reports an invalid plan before touching storage: $version/$name",
    async ({ version, name }) => {
      const actor = env.DATABASE_PROBE.getByName(crypto.randomUUID());
      await runInDurableObject(actor, (_instance, state) => {
        const transaction = vi.spyOn(state.storage, "transactionSync");
        const logger = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(() =>
            migrateActorStorage(
              state.storage,
              [{ version, name, sql: "private SQL" }],
              { schema: "message_owner" },
            ),
          ).toThrow(/named and contiguous/);
          expect(transaction).not.toHaveBeenCalled();
          expect(logger).toHaveBeenCalledExactlyOnceWith({
            event: "actor_migration_failed",
            schema: "message_owner",
            phase: "validate_plan",
            reason: "invalid_plan",
            supportedVersion: 1,
            migrationVersion: version,
            expectedVersion: 1,
            errorName: "Error",
          });
        } finally {
          transaction.mockRestore();
          logger.mockRestore();
        }
      });
    },
  );

  it("rethrows the original failure even when the diagnostic sink throws", async () => {
    const actor = env.DATABASE_PROBE.getByName(crypto.randomUUID());
    await runInDurableObject(actor, (_instance, state) => {
      const failure = new Error("private storage failure");
      const transaction = vi
        .spyOn(state.storage, "transactionSync")
        .mockImplementation(() => {
          throw failure;
        });
      const logger = vi.spyOn(console, "error").mockImplementation(() => {
        throw new Error("sink failure");
      });
      try {
        let caught: unknown;
        try {
          migrateActorStorage(state.storage, initialMigrations, {
            schema: "message_owner",
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(logger).toHaveBeenCalledExactlyOnceWith({
          event: "actor_migration_failed",
          schema: "message_owner",
          phase: "transaction",
          supportedVersion: 1,
          errorName: "Error",
        });
      } finally {
        transaction.mockRestore();
        logger.mockRestore();
      }
    });
  });
});
