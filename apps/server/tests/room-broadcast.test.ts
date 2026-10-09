import { acceptedMessage as accepted } from "@tests/helpers/messaging";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { mutateMessage } from "@/server/actors/shared/messages";
import { observeSql, selectStatements } from "@tests/helpers/sql-observer";
import {
  broadcastCommit,
  reevaluateSockets,
} from "@/server/actors/shared/sockets";
import { messageCommand } from "@tests/helpers/application-harness";
import { principal, room, socket, barrier } from "@tests/helpers/room-socket";

describe("room socket progress and transient signals", () => {
  it("emits exact channel predecessors across other-channel gaps, edits, delayed publication, retries and pruning", async () => {
    const { id, owner } = await room();
    const other = crypto.randomUUID();
    expect(
      await owner.createChannel(principal("alice"), {
        channelId: other,
        name: "Other",
        private: false,
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "changed" });
    const stream = await socket(owner, id);
    try {
      const command = messageCommand(id, "First");
      const first = accepted(
        (await owner.send(principal("alice"), command)).outcome,
      );
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 0,
        replayFloor: 0,
        event: { sequence: 1 },
      });
      accepted(
        (await owner.send(principal("alice"), messageCommand(other))).outcome,
      );
      accepted(
        (await owner.send(principal("alice"), messageCommand(id, "Third")))
          .outcome,
      );
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 1,
        event: { sequence: 3 },
      });
      accepted(
        await owner.edit(principal("alice"), {
          ...messageCommand(id, "Edited"),
          messageId: first.messageId,
          expectedVersion: 1,
        }),
      );
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 3,
        event: { sequence: 4, operation: "edit" },
      });

      // Commit without publication to exercise an older receipt arriving after a newer event.
      const delayed = await runInDurableObject(owner, (_instance, state) =>
        mutateMessage(
          state.storage,
          openOwnerDatabase(state.storage),
          principal("alice"),
          { kind: "send", command: messageCommand(id, "Delayed") },
          Number.MAX_SAFE_INTEGER,
        ),
      );
      // This fixture bypasses MessageDO's public accepted-receipt adapter.
      if (delayed.kind !== "committed") throw new Error(delayed.kind);
      const delayedReceipt = delayed.receipt;
      accepted(
        (await owner.send(principal("alice"), messageCommand(id, "Later")))
          .outcome,
      );
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 5,
        event: { sequence: 6 },
      });
      await runInDurableObject(owner, (_instance, state) =>
        broadcastCommit(
          state,
          openOwnerDatabase(state.storage),
          delayedReceipt,
        ),
      );
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 4,
        event: { sequence: 5 },
      });
      expect(
        accepted((await owner.send(principal("alice"), command)).outcome),
      ).toEqual(first);
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 0,
        event: { sequence: 1 },
      });

      accepted(
        (await owner.send(principal("alice"), messageCommand(other))).outcome,
      );
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM events");
        state.storage.sql.exec(
          "UPDATE owner_state SET replay_floor = high_water",
        );
      });
      accepted(
        (
          await owner.send(
            principal("alice"),
            messageCommand(id, "After prune"),
          )
        ).outcome,
      );
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 6,
        replayFloor: 7,
        event: { sequence: 8 },
      });
      // A matching predecessor alone is insufficient when the cursor is below the floor.
      expect(
        await owner.replay(principal("alice"), {
          channelId: id,
          cursor: { ...stream.ready.cursor, sequence: 6 },
        }),
      ).toEqual({ kind: "reset_required", reason: "floor" });
      expect(
        await owner.replay(principal("alice"), {
          channelId: id,
          cursor: {
            ...stream.ready.cursor,
            sequence: 7,
            generation: crypto.randomUUID(),
          },
        }),
      ).toEqual({ kind: "reset_required", reason: "generation" });
      expect(
        accepted((await owner.send(principal("alice"), command)).outcome),
      ).toEqual(first);
      await barrier(stream); // A pruned retry cannot invent a predecessor or a new frame.
      expect(
        stream.frames.filter((frame) => frame.type === "committed"),
      ).toHaveLength(7);
    } finally {
      await stream.close();
    }
  });

  it("rolls back channel progress with a failed event write and retries from the last committed predecessor", async () => {
    const { id, owner } = await room();
    const stream = await socket(owner, id);
    try {
      accepted(
        (await owner.send(principal("alice"), messageCommand(id))).outcome,
      );
      await stream.next();
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
        );
      });
      const command = messageCommand(id, "Rollback");
      const failure = await runInDurableObject(
        owner,
        async (_instance, state) => {
          try {
            await mutateMessage(
              state.storage,
              openOwnerDatabase(state.storage),
              principal("alice"),
              { kind: "send", command },
              Number.MAX_SAFE_INTEGER,
            );
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      );
      expect(failure).toContain("injected event failure");
      await runInDurableObject(owner, (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT last_sequence FROM channel_progress")
            .one(),
        ).toEqual({ last_sequence: 1 });
        expect(
          state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
        ).toEqual({ high_water: 1 });
        expect(
          state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one(),
        ).toEqual({ n: 1 });
        state.storage.sql.exec("DROP TRIGGER reject_event");
      });
      expect(
        accepted((await owner.send(principal("alice"), command)).outcome)
          .sequence,
      ).toBe(2);
      expect(await stream.next()).toMatchObject({
        type: "committed",
        previous: 1,
        event: { sequence: 2 },
      });
    } finally {
      await stream.close();
    }
  });
});
it("shares broadcast details across accounts and sockets while enforcing each socket's authority", async () => {
  const { id, owner } = await room();
  const readerIds = [
    "alice",
    ...Array.from({ length: 51 }, (_, index) => `reader-${index}`),
  ];
  await runInDurableObject(owner, (_instance, state) => {
    for (const userId of [
      ...readerIds.slice(1),
      "revoked",
      "expired",
      "failed",
    ])
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES (?,'member')",
        userId,
      );
  });
  const receipt = accepted(
    (
      await owner.send(
        principal("alice"),
        messageCommand(id, "Broadcast details"),
      )
    ).outcome,
  );
  await runInDurableObject(owner, (_instance, state) => {
    for (const userId of ["alice", "reader-50"])
      state.storage.sql.exec(
        "INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES (?,?,'👍',?)",
        receipt.messageId,
        userId,
        Date.now(),
      );
  });
  const streams = [];
  try {
    for (const userId of [
      ...readerIds,
      "alice",
      "revoked",
      "expired",
      "failed",
    ])
      streams.push({ userId, stream: await socket(owner, id, userId) });
    const observed = await runInDurableObject(
      owner,
      async (_instance, state) => {
        const database = openOwnerDatabase(state.storage);
        state.storage.sql.exec("DELETE FROM members WHERE user_id='revoked'");
        const expired = state
          .getWebSockets()
          .find(
            (socket) => socket.deserializeAttachment().userId === "expired",
          )!;
        expired.serializeAttachment({
          ...expired.deserializeAttachment(),
          leaseExpiresAt: 0,
        });
        const failed = state
          .getWebSockets()
          .find(
            (socket) => socket.deserializeAttachment().userId === "failed",
          )!;
        const send = vi.spyOn(failed, "send").mockImplementation(() => {
          throw new Error("injected send failure");
        });
        try {
          return await observeSql(state.storage.sql, () =>
            broadcastCommit(state, database, receipt),
          );
        } finally {
          send.mockRestore();
        }
      },
    );
    for (const { userId, stream } of streams) {
      if (userId === "failed") continue;
      const frame = await stream.next();
      if (userId === "revoked" || userId === "expired") {
        expect(frame).toEqual({
          type: userId === "revoked" ? "access_changed" : "lease_expired",
        });
      } else {
        expect(frame).toMatchObject({
          type: "committed",
          previous: 0,
          event: {
            message: {
              body: "Broadcast details",
              reactions: [
                {
                  emoji: "👍",
                  count: 2,
                  mine: userId === "alice" || userId === "reader-50",
                },
              ],
            },
          },
        });
      }
    }
    const failedStream = streams.find(
      ({ userId }) => userId === "failed",
    )!.stream;
    // Its ready cursor already included the Send; replay from before the missed publication.
    expect(
      await owner.replay(principal("failed"), {
        channelId: id,
        cursor: { ...failedStream.ready.cursor, sequence: 0 },
      }),
    ).toMatchObject({
      kind: "replay",
      events: [
        {
          message: {
            id: receipt.messageId,
            body: "Broadcast details",
            reactions: [{ mine: false }],
          },
        },
      ],
    });
    const selects = selectStatements(observed.statements);
    expect(selects.length).toBeLessThanOrEqual(8);
    expect(
      selects.filter(({ query }) => /from "owner_state"/.test(query)),
    ).toHaveLength(1);
    expect(
      observed.statements.every(({ bindings }) => bindings.length <= 100),
    ).toBe(true);
    console.log(
      "Native broadcast SQL work",
      JSON.stringify({
        sockets: streams.length,
        selects: selects.length,
        rowsRead: observed.statements.reduce(
          (sum, statement) => sum + statement.rowsRead,
          0,
        ),
        durationMs: observed.durationMs,
      }),
    );
  } finally {
    for (const { stream } of streams) await stream.close();
    await evictDurableObject(owner, { webSockets: "close" });
  }
});

it("rechecks private audiences across broadcasts and hibernation while keeping each connection's lease", async () => {
  const { id, owner } = await room();
  const privateId = crypto.randomUUID();
  const receipt = await runInDurableObject(owner, async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO channels(id,name,private,version,kind) VALUES (?, 'Private', 1, 1, 'text')",
      privateId,
    );
    for (const userId of ["bob", "carol"])
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES (?,'member')",
        userId,
      );
    state.storage.sql.exec(
      "INSERT INTO channel_members(channel_id,user_id) SELECT ?,user_id FROM members",
      privateId,
    );
    const result = await mutateMessage(
      state.storage,
      openOwnerDatabase(state.storage),
      principal("alice"),
      { kind: "send", command: messageCommand(privateId, "Private update") },
      Number.MAX_SAFE_INTEGER,
    );
    if (result.kind !== "committed") throw new Error(result.kind);
    return result.receipt;
  });
  const privateOwner = await socket(owner, privateId);
  const reader = await socket(owner, privateId, "bob");
  const expired = await socket(owner, privateId, "bob");
  const removed = await socket(owner, privateId, "carol");
  const publicOwner = await socket(owner, id);
  const publicReader = await socket(owner, id, "bob");
  const streams = [
    privateOwner,
    reader,
    expired,
    removed,
    publicOwner,
    publicReader,
  ];
  const publish = () =>
    runInDurableObject(owner, (_instance, state) =>
      broadcastCommit(state, openOwnerDatabase(state.storage), receipt),
    );
  try {
    await publish();
    for (const stream of [privateOwner, reader, expired, removed])
      expect(await stream.next()).toMatchObject({ type: "committed" });
    await barrier(publicOwner);
    await barrier(publicReader);
    await runInDurableObject(owner, (_instance, state) => {
      // Ownership alone does not grant access to a private channel.
      state.storage.sql.exec(
        "DELETE FROM channel_members WHERE channel_id=? AND user_id='alice'",
        privateId,
      );
      state.storage.sql.exec("DELETE FROM members WHERE user_id='carol'");
      const connection = state
        .getWebSockets()
        .find(
          (candidate) =>
            candidate.deserializeAttachment().connectionId ===
            expired.ready.connectionId,
        )!;
      connection.serializeAttachment({
        ...connection.deserializeAttachment(),
        leaseExpiresAt: 0,
      });
    });
    await evictDurableObject(owner, { webSockets: "hibernate" });
    await runInDurableObject(owner, (_instance, state) =>
      reevaluateSockets(state, openOwnerDatabase(state.storage)),
    );
    expect(await privateOwner.next()).toEqual({ type: "access_changed" });
    expect(await expired.next()).toEqual({ type: "lease_expired" });
    expect(await removed.next()).toEqual({ type: "access_changed" });
    await publish();
    expect(await reader.next()).toMatchObject({ type: "committed" });
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM channel_members WHERE channel_id=? AND user_id='bob'",
        privateId,
      );
    });
    await publish();
    expect(await reader.next()).toEqual({ type: "access_changed" });
    for (const stream of [publicOwner, publicReader]) {
      await barrier(stream);
      expect(stream.frames.some((frame) => frame.type === "committed")).toBe(
        false,
      );
    }
    expect(
      privateOwner.frames.filter((frame) => frame.type === "committed"),
    ).toHaveLength(1);
    expect(
      reader.frames.filter((frame) => frame.type === "committed"),
    ).toHaveLength(2);
  } finally {
    for (const stream of streams) await stream.close();
    await evictDurableObject(owner, { webSockets: "close" });
  }
});

it("checks independent connection leases after awaited batch authorization", async () => {
  const { id, owner } = await room();
  const receipt = accepted(
    (await owner.send(principal("alice"), messageCommand(id))).outcome,
  );
  const expiring = await socket(owner, id);
  const current = await socket(owner, id);
  try {
    await runInDurableObject(owner, async (_instance, state) => {
      const now = Date.now();
      for (const connection of state.getWebSockets()) {
        const value = connection.deserializeAttachment();
        connection.serializeAttachment({
          ...value,
          leaseExpiresAt:
            now +
            (value.connectionId === expiring.ready.connectionId ? 1 : 30_000),
        });
      }
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const native = state.storage.sql.exec.bind(state.storage.sql);
      let advanced = false;
      const sql = vi
        .spyOn(state.storage.sql, "exec")
        .mockImplementation((query, ...bindings) => {
          const result = native(query, ...bindings);
          if (query.includes('inner join "members"')) {
            advanced = true;
            clock.mockReturnValue(now + 2);
          }
          return result;
        });
      try {
        await broadcastCommit(state, openOwnerDatabase(state.storage), receipt);
        expect(advanced).toBe(true);
      } finally {
        sql.mockRestore();
        clock.mockRestore();
      }
    });
    expect(await expiring.next()).toEqual({ type: "lease_expired" });
    expect(await current.next()).toMatchObject({ type: "committed" });
    expect(expiring.frames.some((frame) => frame.type === "committed")).toBe(
      false,
    );
  } finally {
    await expiring.close();
    await current.close();
    await evictDurableObject(owner, { webSockets: "close" });
  }
});

it("bounds multi-batch broadcast queries to connected readers as the private roster grows", async () => {
  const { id, owner } = await room();
  const receipt = await runInDurableObject(owner, async (_instance, state) => {
    state.storage.sql.exec(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<130) INSERT INTO members(user_id,role) SELECT printf('reader-%03d',x),'member' FROM n",
    );
    state.storage.sql.exec("UPDATE channels SET private=1 WHERE id=?", id);
    state.storage.sql.exec(
      "INSERT INTO channel_members(channel_id,user_id) SELECT ?,user_id FROM members",
      id,
    );
    const result = await mutateMessage(
      state.storage,
      openOwnerDatabase(state.storage),
      principal("alice"),
      { kind: "send", command: messageCommand(id) },
      Number.MAX_SAFE_INTEGER,
    );
    if (result.kind !== "committed") throw new Error(result.kind);
    return result.receipt;
  });
  const streams = [];
  try {
    for (let index = 1; index <= 130; index++)
      streams.push(
        await socket(owner, id, `reader-${String(index).padStart(3, "0")}`),
      );
    const measurements = [];
    for (const grow of [false, true]) {
      const observed = await runInDurableObject(
        owner,
        async (_instance, state) => {
          if (grow) {
            state.storage.sql.exec(
              "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO members(user_id,role) SELECT printf('offline-%05d',x),'member' FROM n",
            );
            state.storage.sql.exec(
              "INSERT INTO channel_members(channel_id,user_id) SELECT ?,user_id FROM members WHERE user_id LIKE 'offline-%'",
              id,
            );
          }
          const database = openOwnerDatabase(state.storage);
          return observeSql(state.storage.sql, () =>
            broadcastCommit(state, database, receipt),
          );
        },
      );
      for (const stream of streams)
        expect(await stream.next()).toMatchObject({ type: "committed" });
      const selects = selectStatements(observed.statements).length;
      const rowsRead = observed.statements.reduce(
        (sum, statement) => sum + statement.rowsRead,
        0,
      );
      expect(selects).toBeLessThanOrEqual(8);
      expect(rowsRead).toBeLessThanOrEqual(410);
      expect(
        observed.statements.every(({ bindings }) => bindings.length <= 100),
      ).toBe(true);
      measurements.push({ selects, rowsRead });
    }
    expect(measurements[1]).toEqual(measurements[0]);
    console.log(
      "Native multi-batch broadcast SQL work",
      JSON.stringify(measurements),
    );
  } finally {
    for (const stream of streams) await stream.close();
    await evictDurableObject(owner, { webSockets: "close" });
  }
});
