import { acceptedMessage as receipt } from "@tests/helpers/messaging";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  COMMAND_RETRY_MS,
  MessagingOutcomeSchema,
  ServerEventSchema,
} from "@vaskel/contracts/messaging";
import {
  alice,
  bob,
  carol,
  server,
  send,
  inviteMember,
  snapshotCursor,
  socket,
} from "@tests/helpers/messaging-owner";

describe("production message owners on real workerd storage", () => {
  it("isolates two server memberships and participant-owned DMs, with idempotent factories", async () => {
    const first = await server("First");
    const second = await server("Second");
    await inviteMember(first.owner);
    expect(await first.owner.directory(bob())).toMatchObject({
      kind: "directory",
      role: "member",
    });
    expect(
      await second.owner.snapshot(bob(), { channelId: second.id }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await first.owner.initialize({
        serverId: first.id,
        name: "First",
        ownerId: "alice",
      }),
    ).toMatchObject({ kind: "initialized" });
    expect(
      await first.owner.initialize({
        serverId: first.id,
        name: "Changed",
        ownerId: "alice",
      }),
    ).toEqual({ kind: "command_conflict" });
    const id = crypto.randomUUID();
    const dm = env.CONVERSATION_DO.getByName(id);
    expect(
      await dm.initialize({
        conversationId: id,
        participantIds: ["bob", "carol"],
      }),
    ).toMatchObject({ kind: "initialized" });
    expect(
      await dm.initialize({
        conversationId: id,
        participantIds: ["carol", "bob"],
      }),
    ).toMatchObject({ kind: "initialized" });
    expect(
      await dm.initialize({
        conversationId: id,
        participantIds: ["alice", "bob"],
      }),
    ).toEqual({ kind: "command_conflict" });
    expect((await dm.send(alice(), send(id))).outcome).toEqual({
      kind: "forbidden",
    });
    const accepted = receipt((await dm.send(bob(), send(id))).outcome);
    expect(accepted.sequence).toBe(1);
    expect(await dm.snapshot(carol(), { channelId: id })).toMatchObject({
      kind: "snapshot",
      messages: [{ authorId: "bob" }],
    });
  });

  it("commits one stable receipt for competing retries, fences changed payloads and rejects expired commands", async () => {
    const { id, owner } = await server();
    const command = send(id);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        owner.send(alice(), command).then(({ outcome }) => outcome),
      ),
    );
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(
      (await owner.send(alice(), { ...command, body: "Changed payload" }))
        .outcome,
    ).toEqual({ kind: "command_conflict" });
    await evictDurableObject(owner);
    expect(
      (
        await owner.send(alice(), {
          body: command.body,
          issuedAt: command.issuedAt,
          commandId: command.commandId,
          channelId: command.channelId,
        })
      ).outcome,
    ).toEqual(outcomes[0]);
    expect(
      (
        await owner.send(alice(), {
          ...command,
          issuedAt: Date.now() - COMMAND_RETRY_MS - 1_000,
        })
      ).outcome,
    ).toEqual({ kind: "command_expired" });
    expect(
      (await owner.send({ ...alice(), expiresAt: 0 }, send(id))).outcome,
    ).toEqual({
      kind: "unauthenticated",
    });
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 1 });
      const rows = state.storage.sql
        .exec("SELECT * FROM command_receipts")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(command.body);
    });
  });

  it.each([
    [
      "message",
      "CREATE TRIGGER injected_failure AFTER INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected message failure'); END",
    ],
    [
      "fts",
      "CREATE TRIGGER injected_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected fts failure'); END",
    ],
    [
      "event",
      "CREATE TRIGGER injected_failure BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
    ],
    [
      "receipt",
      "CREATE TRIGGER injected_failure AFTER INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
    ],
  ])(
    "rolls back message, sequence, search, event and receipt after a real %s failure",
    async (_stage, trigger) => {
      const { id, owner } = await server();
      const command = send(id);
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec(trigger!);
      });
      await expect(
        (async () => (await owner.send(alice(), command)).outcome)(),
      ).rejects.toThrow(/injected/);
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER injected_failure");
        expect(
          state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
        ).toEqual({ high_water: 0 });
        for (const table of [
          "messages",
          "events",
          "command_receipts",
          "message_fts",
        ])
          expect(
            state.storage.sql
              .exec(`SELECT COUNT(*) AS count FROM ${table}`)
              .one(),
          ).toEqual({ count: 0 });
      });
      expect(
        await owner.search(alice(), { channelId: id, query: "東京都" }),
      ).toEqual({ kind: "matches", messages: [] });
      expect(
        receipt((await owner.send(alice(), command)).outcome).sequence,
      ).toBe(1);
    },
  );

  it("rolls back a failed deletion without losing search or retaining a partial payload", async () => {
    const { id, owner } = await server();
    const command = send(id);
    const accepted = receipt((await owner.send(alice(), command)).outcome);
    const deletion = {
      channelId: id,
      commandId: "delete-rollback",
      issuedAt: Date.now(),
      messageId: accepted.messageId,
      expectedVersion: 1,
    };
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER injected_delete_failure AFTER INSERT ON command_receipts WHEN NEW.operation = 'delete' BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END",
      );
    });
    await expect(
      (async () => await owner.deleteMessage(alice(), deletion))(),
    ).rejects.toThrow(/injected deletion/);
    expect(await owner.snapshot(alice(), { channelId: id })).toMatchObject({
      kind: "snapshot",
      messages: [{ body: command.body, version: 1, deletedAt: null }],
    });
    expect(
      await owner.search(alice(), { channelId: id, query: "東京都" }),
    ).toMatchObject({ kind: "matches", messages: [{ body: command.body }] });
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER injected_delete_failure");
      expect(
        state.storage.sql.exec("SELECT * FROM deleted_payloads").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 1 });
    });
    expect(receipt(await owner.deleteMessage(alice(), deletion))).toMatchObject(
      { sequence: 2, version: 2 },
    );
  });

  it("refuses a future owner schema when the runtime reconstructs the production actor", async () => {
    const { owner } = await server();
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO vaskel_schema_migrations(version, name) VALUES (999, 'future-owner-schema')",
      );
    });
    await evictDurableObject(owner);
    await expect(
      (async () => await owner.directory(alice()))(),
    ).rejects.toThrow(/newer than or incompatible/);
  });

  it("updates native literal search atomically and resolves old replay rows to current tombstones", async () => {
    const { id, owner } = await server();
    await inviteMember(owner);
    const start = await snapshotCursor(owner, id);
    const command = send(id);
    const accepted = receipt((await owner.send(alice(), command)).outcome);
    expect(
      await owner.search(bob(), { channelId: id, query: "東京都" }),
    ).toMatchObject({ kind: "matches", messages: [{ body: command.body }] });
    const edit = {
      channelId: id,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      messageId: accepted.messageId,
      expectedVersion: 1,
      body: '𠮷野家 literal alpha OR beta say "hello"',
    };
    expect(await owner.edit(bob(), edit)).toEqual({ kind: "forbidden" });
    const edited = receipt(await owner.edit(alice(), edit));
    expect(edited.version).toBe(2);
    expect(await owner.edit(alice(), { ...edit, commandId: "stale" })).toEqual({
      kind: "stale_version",
      currentVersion: 2,
    });
    expect(
      await owner.search(alice(), { channelId: id, query: "東京都" }),
    ).toEqual({ kind: "matches", messages: [] });
    for (const query of ["𠮷野家", "alpha OR beta", 'say "hello"'])
      expect(
        await owner.search(alice(), { channelId: id, query }),
      ).toMatchObject({
        kind: "matches",
        messages: [{ id: accepted.messageId }],
      });
    for (const query of ["東京", "𠮷野"])
      expect(await owner.search(alice(), { channelId: id, query })).toEqual({
        kind: "query_too_short",
        minimum: 3,
      });
    const deletion = {
      channelId: id,
      commandId: "delete-1",
      issuedAt: Date.now(),
      messageId: accepted.messageId,
      expectedVersion: 2,
    };
    const deleted = receipt(await owner.deleteMessage(alice(), deletion));
    expect(deleted.version).toBe(3);
    expect(await owner.deleteMessage(alice(), deletion)).toEqual({
      kind: "accepted",
      receipt: deleted,
    });
    expect((await owner.send(alice(), command)).outcome).toEqual({
      kind: "accepted",
      receipt: accepted,
    });
    expect(
      await owner.search(alice(), { channelId: id, query: "literal" }),
    ).toEqual({ kind: "matches", messages: [] });
    const replayed = MessagingOutcomeSchema.parse(
      await owner.replay(bob(), { channelId: id, cursor: start }),
    );
    if (replayed.kind !== "replay") throw new Error("Expected replay");
    expect(replayed.events).toHaveLength(3);
    for (const event of replayed.events)
      expect(event.message).toMatchObject({ body: null, version: 3 });
    expect(
      ServerEventSchema.safeParse({
        type: "committed",
        previous: 0,
        replayFloor: 0,
        cursor: start,
        event: {
          ...replayed.events[0],
          message: { ...replayed.events[0]?.message, body: edit.body },
        },
      }).success,
    ).toBe(false);
    expect(await owner.snapshot(alice(), { channelId: id })).toMatchObject({
      kind: "snapshot",
      messages: [{ body: null, deletedAt: expect.any(Number) }],
    });
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT body FROM deleted_payloads").one(),
      ).toEqual({ body: edit.body });
      expect(
        JSON.stringify(
          state.storage.sql.exec("SELECT * FROM events").toArray(),
        ),
      ).not.toContain(edit.body);
      state.storage.sql.exec("UPDATE deleted_payloads SET eligible_at = 0");
    });
    expect(await runDurableObjectAlarm(owner)).toBe(true);
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM deleted_payloads").toArray(),
      ).toEqual([]);
    });
  });

  it("keeps reads private and tied to creation positions while paginating bounded history", async () => {
    const { id, owner } = await server();
    await inviteMember(owner);
    const first = receipt(
      (await owner.send(alice(), send(id, "First message"))).outcome,
    );
    const second = receipt(
      (await owner.send(bob(), send(id, "Second message"))).outcome,
    );
    expect(
      await owner.updateRead(bob(), {
        channelId: id,
        sequence: second.sequence,
      }),
    ).toEqual({ kind: "read_updated", sequence: 2 });
    expect(
      await owner.updateRead(bob(), { channelId: id, sequence: 1 }),
    ).toEqual({ kind: "read_updated", sequence: 2 });
    expect(await owner.snapshot(alice(), { channelId: id })).toMatchObject({
      kind: "snapshot",
      readSequence: 0,
    });
    expect(await owner.snapshot(bob(), { channelId: id })).toMatchObject({
      kind: "snapshot",
      readSequence: 2,
    });
    receipt(
      await owner.edit(alice(), {
        channelId: id,
        commandId: "edit",
        issuedAt: Date.now(),
        messageId: first.messageId,
        expectedVersion: 1,
        body: "First edited",
      }),
    );
    expect(
      await owner.updateRead(bob(), { channelId: id, sequence: 3 }),
    ).toEqual({ kind: "invalid_input" });
    const recent = MessagingOutcomeSchema.parse(
      await owner.snapshot(alice(), { channelId: id, limit: 1 }),
    );
    if (recent.kind !== "snapshot") throw new Error("Expected snapshot");
    expect(recent.messages[0]?.id).toBe(second.messageId);
    expect(recent.nextBefore).toBe(2);
    expect(
      await owner.snapshot(alice(), {
        channelId: id,
        before: recent.nextBefore!,
        limit: 1,
      }),
    ).toMatchObject({
      kind: "snapshot",
      messages: [{ id: first.messageId }],
      nextBefore: null,
    });
  });

  it("bounds replay pages, distinguishes filtered progress, and keeps high-water after complete pruning", async () => {
    const { id, owner } = await server();
    const start = await snapshotCursor(owner, id);
    const hidden = crypto.randomUUID();
    expect(
      await owner.createChannel(alice(), {
        channelId: hidden,
        name: "秘密",
        private: true,
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "changed" });
    receipt((await owner.send(alice(), send(id, "Visible first"))).outcome);
    receipt((await owner.send(alice(), send(hidden, "Hidden gap"))).outcome);
    receipt((await owner.send(alice(), send(id, "Visible last"))).outcome);
    const page = MessagingOutcomeSchema.parse(
      await owner.replay(alice(), { channelId: id, cursor: start, limit: 1 }),
    );
    if (page.kind !== "replay") throw new Error("Expected replay");
    expect(page).toMatchObject({
      hasMore: true,
      highWater: 3,
      cursor: { sequence: 1 },
    });
    expect(
      await owner.replay(alice(), {
        channelId: id,
        cursor: page.cursor,
        limit: 1,
      }),
    ).toMatchObject({
      kind: "replay",
      hasMore: false,
      cursor: { sequence: 3 },
      events: [{ sequence: 3 }],
    });
    expect(
      await owner.replay(alice(), {
        channelId: id,
        cursor: { ...start, channelId: hidden },
      }),
    ).toEqual({ kind: "reset_required", reason: "scope" });
    expect(
      await owner.replay(alice(), {
        channelId: id,
        cursor: { ...start, generation: crypto.randomUUID() },
      }),
    ).toEqual({ kind: "reset_required", reason: "generation" });
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM events");
      state.storage.sql.exec(
        "UPDATE owner_state SET replay_floor = high_water",
      );
    });
    await evictDurableObject(owner);
    expect(
      await owner.replay(alice(), { channelId: id, cursor: start }),
    ).toEqual({ kind: "reset_required", reason: "floor" });
    expect(
      receipt((await owner.send(alice(), send(id))).outcome).sequence,
    ).toBe(4);
  });

  it("reevaluates current private access before history, search, replay, retries and socket delivery", async () => {
    const { id, owner } = await server();
    await inviteMember(owner);
    const channelId = crypto.randomUUID();
    expect(
      await owner.createChannel(alice(), {
        channelId,
        name: "Private",
        private: true,
        expectedVersion: 2,
      }),
    ).toMatchObject({ kind: "changed" });
    expect(
      await owner.setChannelMember(alice(), {
        channelId,
        userId: "bob",
        allowed: true,
        expectedVersion: 1,
      }),
    ).toEqual({ kind: "changed", version: 2 });
    const stream = await socket(owner, channelId, bob());
    const start = await snapshotCursor(owner, channelId);
    const command = send(channelId);
    const frame = stream.next();
    receipt((await owner.send(bob(), command)).outcome);
    expect((await frame).type).toBe("committed");
    const changed = stream.next();
    expect(
      await owner.setChannelMember(alice(), {
        channelId,
        userId: "bob",
        allowed: false,
        expectedVersion: 2,
      }),
    ).toEqual({ kind: "changed", version: 3 });
    expect(await changed).toEqual({ type: "access_changed" });
    for (const outcome of await Promise.all([
      owner.send(bob(), command).then(({ outcome }) => outcome),
      owner.snapshot(bob(), { channelId }),
      owner.search(bob(), { channelId, query: "東京都" }),
      owner.replay(bob(), { channelId, cursor: start }),
      owner.prepareSocket(bob(), { channelId }),
    ]))
      expect(outcome).toEqual({ kind: "forbidden" });
    expect(await owner.directory(bob())).toMatchObject({
      kind: "directory",
      channels: [{ id }],
    });
    expect(
      await owner.setChannelMember(alice(), {
        channelId,
        userId: "alice",
        allowed: false,
        expectedVersion: 3,
      }),
    ).toEqual({ kind: "changed", version: 4 });
    expect(await owner.snapshot(alice(), { channelId })).toEqual({
      kind: "forbidden",
    });
    stream.client.close();
  });
});
