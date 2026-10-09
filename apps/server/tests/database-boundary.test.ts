import { barrier } from "@tests/helpers/barrier";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";
import { appendProbeMessage } from "@tests/fixtures/probe-operations";
import {
  initialMigrations,
  type ProbeCommand,
  type ProbeDatabase,
} from "@tests/fixtures/probe-schema";

const command: ProbeCommand = {
  actorId: "account-a",
  commandId: "send-1",
  body: "今日は東京都で話しましょう。数据库设计와 데이터베이스",
};

function probe(name = "database-boundary") {
  return env.DATABASE_PROBE.getByName(`${name}:${crypto.randomUUID()}`);
}

describe("Kysely on real SQLite Durable Object storage", () => {
  it("acknowledges only after awaited message, FTS, event, receipt and sequence writes commit", async () => {
    const owner = probe();
    const outcome = await owner.append(command);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted")
      throw new Error("Expected committed receipt");
    const { messageId, sequence } = outcome.receipt;
    expect(sequence).toBe(1);
    // Graceful runtime eviction loses the instance and keeps its real SQLite data.
    await evictDurableObject(owner);
    const snapshot = await owner.snapshot();
    expect(snapshot).toEqual({
      highWater: 1,
      searchPolicy: "native-trigram-v1",
      messages: [
        {
          id: messageId,
          author_id: command.actorId,
          body: command.body,
          sequence,
        },
      ],
      events: [{ sequence, message_id: messageId }],
      receipts: [
        {
          actor_id: command.actorId,
          operation: "send",
          command_id: command.commandId,
          payload: command.body,
          message_id: messageId,
          sequence,
        },
      ],
      fts: [messageId],
    });
    expect(await owner.search("東京都")).toEqual({
      kind: "matches",
      messageIds: [messageId],
    });
  });

  it.each(["message", "fts", "event", "receipt"] as const)(
    "rolls back a real SQL constraint failure after the %s write and allows a clean retry",
    async (stage) => {
      const owner = probe();
      await expect(
        (async () => await owner.append(command, stage))(),
      ).rejects.toThrow(/UNIQUE constraint failed/);
      expect(await owner.snapshot()).toEqual({
        highWater: 0,
        searchPolicy: "native-trigram-v1",
        messages: [],
        events: [],
        receipts: [],
        fts: [],
      });
      expect(await owner.search("東京都")).toEqual({
        kind: "matches",
        messageIds: [],
      });
      expect(await owner.append(command)).toMatchObject({
        kind: "accepted",
        receipt: { sequence: 1 },
      });
    },
  );

  it("rolls back a contentless FTS delete with its failed transaction and keeps the document matchable", async () => {
    const owner = probe();
    const accepted = await owner.append(command);
    if (accepted.kind !== "accepted") throw new Error("Expected receipt");
    const { messageId } = accepted.receipt;
    const before = await owner.snapshot();
    await expect(
      (async () => await owner.remove(messageId, true))(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await owner.snapshot()).toEqual(before);
    expect(await owner.search("東京都")).toEqual({
      kind: "matches",
      messageIds: [messageId],
    });
    // The committed delete removes only the search document; row and receipt stay.
    expect(await owner.remove(messageId)).toBe(2);
    expect(await owner.search("東京都")).toEqual({
      kind: "matches",
      messageIds: [],
    });
    expect(await owner.snapshot()).toEqual({
      ...before,
      highWater: 2,
      events: [...before.events, { sequence: 2, message_id: messageId }],
      fts: [],
    });
    expect(await owner.append(command)).toEqual(accepted);
  });

  it("serializes a competing command while the first transaction is paused, then rolls back only the failed command", async () => {
    const owner = probe();
    await runInDurableObject(owner, async (_instance, state) => {
      const database = createActorDatabase<ProbeDatabase>(state.storage);
      const written = barrier();
      const resume = barrier();
      const trace: string[] = [];
      const first = appendProbeMessage(state.storage, database, command, {
        failAfter: "receipt",
        afterMessageWrite: async () => {
          trace.push("first-written");
          written.release();
          await resume.promise;
          trace.push("first-resumed");
        },
      });
      await written.promise;
      const competing = appendProbeMessage(
        state.storage,
        database,
        {
          ...command,
          commandId: "competing",
          body: "committed competing message",
        },
        {
          afterMessageWrite: async () => {
            trace.push("competing-written");
          },
        },
      );
      resume.release();
      const results = await Promise.allSettled([first, competing]);
      expect(results[0]?.status).toBe("rejected");
      expect(results[1]).toMatchObject({
        status: "fulfilled",
        value: { kind: "accepted", receipt: { sequence: 1 } },
      });
      expect(trace).toEqual([
        "first-written",
        "first-resumed",
        "competing-written",
      ]);
    });
    const snapshot = await owner.snapshot();
    expect(snapshot.highWater).toBe(1);
    expect(snapshot.messages.map((row) => row.body)).toEqual([
      "committed competing message",
    ]);
    expect(snapshot.fts).toEqual(snapshot.messages.map((row) => row.id));
    expect(await owner.search("committed competing")).toEqual({
      kind: "matches",
      messageIds: snapshot.messages.map((row) => row.id),
    });
    expect(await owner.search("東京都")).toEqual({
      kind: "matches",
      messageIds: [],
    });
    expect(snapshot.receipts.map((row) => row.command_id)).toEqual([
      "competing",
    ]);
    expect(snapshot.events).toHaveLength(1);
  });

  it("gives concurrently dispatched RPC commands independent, monotonically increasing receipts", async () => {
    const owner = probe();
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        owner.append({
          ...command,
          commandId: `send-${index}`,
          body: `message ${index}`,
        }),
      ),
    );
    const sequences = results.map((outcome) => {
      if (outcome.kind !== "accepted")
        throw new Error("Unexpected command conflict");
      return outcome.receipt.sequence;
    });
    expect(sequences.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    const snapshot = await owner.snapshot();
    expect(snapshot.highWater).toBe(16);
    expect(snapshot.messages).toHaveLength(16);
    expect(snapshot.events).toHaveLength(16);
    expect(snapshot.fts).toHaveLength(16);
    expect(snapshot.receipts).toHaveLength(16);
  });

  it("recovers one stable receipt for concurrent retries and rejects changed payloads", async () => {
    const owner = probe();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => owner.append(command)),
    );
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(await owner.append({ ...command, body: "different body" })).toEqual({
      kind: "command_conflict",
    });
    const snapshot = await owner.snapshot();
    expect(snapshot.highWater).toBe(1);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.receipts).toHaveLength(1);
    // Actor identity and owner scope are part of the receipt namespace, not global keys.
    expect(
      await owner.append({ ...command, actorId: "account-b" }),
    ).toMatchObject({ kind: "accepted", receipt: { sequence: 2 } });
    expect(await probe("another-owner").append(command)).toMatchObject({
      kind: "accepted",
      receipt: { sequence: 1 },
    });
  });

  it("keeps sequence high-water and receipts after every replay row is pruned", async () => {
    const owner = probe();
    const original = await owner.append(command);
    await owner.pruneReplay();
    await evictDurableObject(owner);
    expect((await owner.snapshot()).events).toEqual([]);
    expect(await owner.append(command)).toEqual(original);
    expect(
      await owner.append({ ...command, commandId: "after-gc" }),
    ).toMatchObject({ kind: "accepted", receipt: { sequence: 2 } });
    expect((await owner.snapshot()).events.map((row) => row.sequence)).toEqual([
      2,
    ]);
  });

  it("rejects unsupported Kysely transactions without running their callback", async () => {
    await runInDurableObject(probe(), async (_instance, state) => {
      const database = createActorDatabase<ProbeDatabase>(state.storage);
      let entered = false;
      await expect(
        database.transaction().execute(async () => {
          entered = true;
        }),
      ).rejects.toThrow(/transactions are not supported/);
      expect(entered).toBe(false);
    });
  });
});

describe("native actor migrations", () => {
  it("rolls back partial DDL, FTS and data changes along with the failed schema version", async () => {
    const owner = probe();
    await owner.append(command);
    const before = await owner.snapshot();
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect((async () => await owner.upgrade(true))()).rejects.toThrow(
        /no such table/,
      );
      expect(logger).toHaveBeenCalledExactlyOnceWith({
        event: "actor_migration_failed",
        actorId: owner.id.toString(),
        schema: "message_owner",
        phase: "execute_sql",
        supportedVersion: 2,
        migrationVersion: 2,
        migrationName: "rejected_upgrade",
        errorName: "Error",
      });
    } finally {
      logger.mockRestore();
    }
    expect(await owner.snapshot()).toEqual(before);
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT version FROM vaskel_schema_migrations")
          .toArray(),
      ).toEqual([{ version: 1 }]);
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name LIKE 'rejected_%'")
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec("PRAGMA table_info(messages)")
          .toArray()
          .map((column) => column.name),
      ).not.toContain("rejected_revision");
    });
    expect(await owner.search("東京都")).toMatchObject({
      kind: "matches",
      messageIds: [before.messages[0]?.id],
    });
    // A corrected upgrade remains possible; the failed version was never accepted.
    const successLogger = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(await owner.upgrade(false)).toBe(2);
      expect(await owner.upgrade(false)).toBe(2);
      expect(successLogger).not.toHaveBeenCalled();
    } finally {
      successLogger.mockRestore();
    }
    expect((await owner.snapshot()).messages).toEqual(
      before.messages.map((row) => ({ ...row, revision: 1 })),
    );
    expect(await owner.append(command)).toEqual({
      kind: "accepted",
      receipt: { messageId: before.messages[0]?.id, sequence: 1 },
    });
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT revision FROM messages").one(),
      ).toEqual({ revision: 1 });
      expect(() =>
        migrateActorStorage(state.storage, initialMigrations, {
          schema: "message_owner",
          actorId: state.id.toString(),
        }),
      ).toThrow(/newer than or incompatible/);
      expect(
        state.storage.sql
          .exec("SELECT MAX(version) AS version FROM vaskel_schema_migrations")
          .one(),
      ).toEqual({ version: 2 });
    });
  });

  it("reconstructs an upgraded actor after runtime eviction with its data and receipts intact", async () => {
    const owner = probe();
    const accepted = await owner.append(command);
    expect(await owner.upgrade(false)).toBe(2);
    await evictDurableObject(owner);
    expect(await owner.append(command)).toEqual(accepted);
    const snapshot = await owner.snapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      body: command.body,
      revision: 1,
    });
    expect(snapshot.highWater).toBe(1);
  });
});

describe("workerd native literal trigram policy", () => {
  it.each(["東京都", "数据库", "데이터베이스"])(
    "finds %s within original mixed-script text",
    async (query) => {
      const owner = probe();
      const accepted = await owner.append(command);
      if (accepted.kind !== "accepted") throw new Error("Expected receipt");
      expect(await owner.search(query)).toEqual({
        kind: "matches",
        messageIds: [accepted.receipt.messageId],
      });
    },
  );

  it("handles supplementary Han and treats FTS syntax/quotes as literal text", async () => {
    const owner = probe();
    const han = await owner.append({ ...command, body: "𠮷野家の会話" });
    const quotes = await owner.append({
      ...command,
      commandId: "quoted",
      body: 'literal alpha OR beta and say "hello" safely',
    });
    if (han.kind !== "accepted" || quotes.kind !== "accepted")
      throw new Error("Expected receipts");
    expect(await owner.search("𠮷野家")).toEqual({
      kind: "matches",
      messageIds: [han.receipt.messageId],
    });
    expect(await owner.search("alpha OR beta")).toEqual({
      kind: "matches",
      messageIds: [quotes.receipt.messageId],
    });
    expect(await owner.search('say "hello"')).toEqual({
      kind: "matches",
      messageIds: [quotes.receipt.messageId],
    });
    expect(await owner.search("東京都 OR alpha")).toEqual({
      kind: "matches",
      messageIds: [],
    });
  });
});
