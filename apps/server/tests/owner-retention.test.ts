import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import {
  ownerRetentionWake,
  pruneOwnerRetention,
  retentionWake,
  RECEIPT_RETENTION_MS,
  AUTHORIZATION_RETENTION_MS,
} from "@/server/actors/shared/retention";
import {
  refreshOwnerAlarm,
  ownerAlarm,
} from "@/server/actors/shared/maintenance";
import { mutateMessage } from "@/server/actors/shared/messages";
import {
  drainDirectorySync,
  DIRECTORY_SYNC_AT,
  queueDirectorySync,
} from "@/server/actors/shared/directory-sync";
import { setBlock } from "@/server/actors/conversation/blocks";
import { authorizeRegistration } from "@/server/actors/server/invitations";
import { messageCommand } from "@tests/helpers/application-harness";

const HOUR = 3_600_000;
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  const principal = {
    userId: "alice",
    sessionId: "session",
    expiresAt: Date.now() + 60 * 24 * HOUR,
  };
  await owner.initialize({
    serverId: id,
    name: "Retention",
    ownerId: principal.userId,
  });
  return { id, owner, principal };
}
function seed(storage: DurableObjectStorage, now: number, count: number) {
  // Reverse insertion order distinguishes indexed oldest-first selection from rowid order.
  for (let i = count - 1; i >= 0; i--) {
    storage.sql.exec(
      "INSERT INTO command_receipts VALUES ('alice', 'send', ?, 'hash', 'message', 1, 1, ?, ?)",
      `command-${i}`,
      now - RECEIPT_RETENTION_MS - i,
      now - RECEIPT_RETENTION_MS + i,
    );
    storage.sql.exec(
      "INSERT INTO block_receipts VALUES ('alice', ?, 'hash', 1, 1, ?)",
      `block-${i}`,
      now - RECEIPT_RETENTION_MS + i,
    );
    storage.sql.exec(
      "INSERT INTO registration_authorizations VALUES (?, 'invite', 'user', ?, 0, ?)",
      `registration-${i}`,
      now - AUTHORIZATION_RETENTION_MS + i + 600_000,
      now - AUTHORIZATION_RETENTION_MS + i,
    );
  }
}
function counts(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{ commands: number; blocks: number; registrations: number }>(
      `SELECT
    (SELECT COUNT(*) FROM command_receipts) AS commands,
    (SELECT COUNT(*) FROM block_receipts) AS blocks,
    (SELECT COUNT(*) FROM registration_authorizations) AS registrations`,
    )
    .one();
}

describe("idle owner receipt retention", () => {
  it("atomically arms block and registration insertion and drains their idle receipts after eviction", async () => {
    const now = Date.now() + 60 * 24 * HOUR;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    const invitation = await h.owner.createInvite(
      { ...h.principal, invitePolicy: "members" },
      { expiresAt: now + HOUR },
    );
    if (invitation.kind !== "invite_created") throw new Error(invitation.kind);
    const conversation = env.CONVERSATION_DO.getByName(crypto.randomUUID());
    for (const kind of ["block", "registration"] as const) {
      const owner = kind === "block" ? conversation : h.owner;
      const retention =
        kind === "block" ? RECEIPT_RETENTION_MS : AUTHORIZATION_RETENTION_MS;
      await runInDurableObject(owner, async (_instance, ctx) => {
        const db = openOwnerDatabase(ctx.storage);
        const block = {
          commandId: crypto.randomUUID(),
          issuedAt: now,
          blocked: true,
          expectedRevision: 0,
        };
        const pair = {
          conversationId: crypto.randomUUID(),
          participantIds: ["alice", "bob"] as [string, string],
        };
        const registration = {
          token: invitation.token,
          registrationId: crypto.randomUUID(),
          userId: "bob",
        };
        const produce = () =>
          kind === "block"
            ? setBlock(ctx.storage, db, h.principal, pair, block)
            : authorizeRegistration(ctx.storage, db, registration, Infinity);
        const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
        const failure = vi
          .spyOn(ctx.storage, "setAlarm")
          .mockImplementation(async (due) => {
            await setAlarm(due);
            throw new Error("alarm write failed");
          });
        try {
          await expect(produce()).rejects.toThrow("alarm write failed");
        } finally {
          failure.mockRestore();
        }
        expect(counts(ctx.storage)).toEqual({
          commands: 0,
          blocks: 0,
          registrations: 0,
        });
        expect(
          ctx.storage.sql.exec("SELECT * FROM direct_blocks").toArray(),
        ).toEqual([]);
        expect(await ctx.storage.getAlarm()).toBeNull();
        expect((await produce()).kind).toBe(
          kind === "block" ? "block_updated" : "registration_authorized",
        );
        expect(await ctx.storage.getAlarm()).toBe(
          retentionWake(now, retention),
        );
      });
      await evictDurableObject(owner);
      clock.mockReturnValue(now + retention);
      expect(await runDurableObjectAlarm(owner)).toBe(true);
      await runInDurableObject(owner, async (_instance, ctx) => {
        expect(counts(ctx.storage)).toEqual({
          commands: 0,
          blocks: 0,
          registrations: 0,
        });
        if (kind === "block")
          expect(
            ctx.storage.sql
              .exec("SELECT blocked, revision FROM direct_blocks")
              .one(),
          ).toEqual({ blocked: 1, revision: 1 });
        expect(await ctx.storage.getAlarm()).toBeNull();
      });
      expect(await runDurableObjectAlarm(owner)).toBe(false);
      clock.mockReturnValue(now);
    }
  });

  it("reclaims native 8 MiB pressure before Send preflight and room growth without changing refusal state", async () => {
    const now = Date.now() + 60 * 24 * HOUR;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    const command = messageCommand(h.id, "accepted retry");
    const receipt = (await h.owner.send(h.principal, command)).outcome;
    await runInDurableObject(h.owner, (_instance, ctx) => {
      seed(ctx.storage, now - 1_000, 1_001);
      ctx.storage.sql.exec(
        "UPDATE command_receipts SET payload_hash = CAST(zeroblob(16000) AS TEXT) WHERE command_id LIKE 'command-%'",
      );
    });
    const inspect = () =>
      runInDurableObject(h.owner, (_instance, ctx) => ({
        ...counts(ctx.storage),
        bytes: ctx.storage.sql.databaseSize,
        state: ctx.storage.sql
          .exec("SELECT high_water, attachment_bytes FROM owner_state")
          .one(),
        channels: ctx.storage.sql
          .exec("SELECT COUNT(*) AS count FROM channels")
          .one(),
        attachments: ctx.storage.sql
          .exec("SELECT COUNT(*) AS count FROM attachments")
          .one(),
        messages: ctx.storage.sql
          .exec("SELECT COUNT(*) AS count FROM messages")
          .one(),
      }));
    const initial = await inspect();
    expect(initial.bytes).toBeGreaterThan(8 * 1024 ** 2);
    expect(await h.owner.capacity(h.principal)).toMatchObject({
      sql: { budgetBytes: 8 * 1024 ** 2, status: "paused" },
    });
    expect(await inspect()).toEqual(initial); // Aggregate inspection is read-only.
    expect(
      await h.owner.prepareSend(
        { ...h.principal, userId: "outsider" },
        command,
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      await h.owner.prepareSend(h.principal, { ...command, issuedAt: 0 }),
    ).toEqual({ kind: "command_expired" });
    expect(await h.owner.prepareSend(h.principal, command)).toEqual(receipt);
    expect(await inspect()).toEqual(initial);
    expect(
      await h.owner.prepareSend(h.principal, messageCommand(h.id, "new")),
    ).toEqual({ kind: "storage_capacity" });
    const first = await inspect();
    expect(first).toEqual({
      ...initial,
      commands: initial.commands - 200,
      blocks: initial.blocks - 200,
      registrations: initial.registrations - 200,
      bytes: first.bytes,
    });
    expect(first.bytes).toBeLessThan(initial.bytes);
    expect(first.bytes).toBeGreaterThan(8 * 1024 ** 2 * 0.85);
    expect(
      await h.owner.createChannel(h.principal, {
        channelId: crypto.randomUUID(),
        name: "new room",
        private: false,
        expectedVersion: 1,
      }),
    ).toEqual({ kind: "storage_capacity" });
    const second = await inspect();
    expect(second).toEqual({
      ...first,
      commands: first.commands - 200,
      blocks: first.blocks - 200,
      registrations: first.registrations - 200,
      bytes: second.bytes,
    });
    expect(second.bytes).toBeLessThan(first.bytes);
    expect(second.bytes).toBeGreaterThan(8 * 1024 ** 2 * 0.85);
    expect((await h.owner.send(h.principal, command)).outcome).toEqual(receipt);
  });

  it("drains independent oldest-first quotas through eviction and leaves canonical state quiescent", async () => {
    const now = Date.now() + 60 * 24 * HOUR;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    await runInDurableObject(h.owner, async (_instance, ctx) => {
      seed(ctx.storage, now - 1_000, 451);
      ctx.storage.sql.exec("INSERT INTO direct_blocks VALUES ('alice', 1, 7)");
      await refreshOwnerAlarm(ctx, openOwnerDatabase(ctx.storage));
      expect(await ctx.storage.getAlarm()).toBe(now + 1_000);
    });
    for (const remaining of [251, 51, 0]) {
      expect(await runDurableObjectAlarm(h.owner)).toBe(true);
      await runInDurableObject(h.owner, async (_instance, ctx) => {
        expect(counts(ctx.storage)).toEqual({
          commands: remaining,
          blocks: remaining,
          registrations: remaining,
        });
        if (remaining) {
          expect(
            ctx.storage.sql
              .exec(
                "SELECT command_id FROM command_receipts ORDER BY accepted_at LIMIT 1",
              )
              .one(),
          ).toEqual({ command_id: `command-${451 - remaining}` });
          expect(
            ctx.storage.sql
              .exec(
                "SELECT command_id FROM block_receipts ORDER BY accepted_at LIMIT 1",
              )
              .one(),
          ).toEqual({ command_id: `block-${451 - remaining}` });
          expect(
            ctx.storage.sql
              .exec(
                "SELECT id FROM registration_authorizations ORDER BY created_at LIMIT 1",
              )
              .one(),
          ).toEqual({ id: `registration-${451 - remaining}` });
        }
        expect(await ctx.storage.getAlarm()).toBe(
          remaining ? now + 1_000 : null,
        );
        expect(
          ctx.storage.sql.exec("SELECT * FROM direct_blocks").one(),
        ).toEqual({ user_id: "alice", blocked: 1, revision: 7 });
        expect(
          ctx.storage.sql.exec("SELECT high_water FROM owner_state").one(),
        ).toEqual({ high_water: 0 });
      });
      await evictDurableObject(h.owner);
    }
    expect(await runDurableObjectAlarm(h.owner)).toBe(false);
  });

  it("keeps an immutable hourly bucket across repeated traffic and prunes exactly at the original boundary", async () => {
    const now = Math.ceil(Date.now() / HOUR) * HOUR + 60 * 24 * HOUR + 123;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    const command = messageCommand(h.id, "retained");
    const accepted = (await h.owner.send(h.principal, command)).outcome;
    expect(accepted.kind).toBe("accepted");
    const bucket = retentionWake(now, RECEIPT_RETENTION_MS);
    for (const advance of [1_000, 3_000, 10_000]) {
      clock.mockReturnValue(now + advance);
      expect((await h.owner.send(h.principal, command)).outcome).toEqual(
        accepted,
      );
      await runInDurableObject(h.owner, async (_instance, ctx) => {
        await refreshOwnerAlarm(ctx, openOwnerDatabase(ctx.storage));
        expect(await ctx.storage.getAlarm()).toBe(bucket);
      });
    }
    await runInDurableObject(h.owner, async (_instance, ctx) => {
      const db = openOwnerDatabase(ctx.storage);
      seed(ctx.storage, now + RECEIPT_RETENTION_MS, 1);
      const urgent = now + 20_000;
      ctx.storage.sql.exec(
        "INSERT INTO socket_tickets VALUES ('ticket', 'alice', 'session', ?, ?, ?)",
        h.id,
        urgent,
        urgent,
      );
      await refreshOwnerAlarm(ctx, db);
      expect(await ctx.storage.getAlarm()).toBe(
        Math.ceil(urgent / 30_000) * 30_000,
      );
      ctx.storage.sql.exec("DELETE FROM socket_tickets");
      await ctx.storage.transaction(() =>
        pruneOwnerRetention(db, now + RECEIPT_RETENTION_MS - 1),
      );
      expect(counts(ctx.storage)).toEqual({
        commands: 2,
        blocks: 1,
        registrations: 1,
      });
      await ctx.storage.transaction(() =>
        pruneOwnerRetention(db, now + RECEIPT_RETENTION_MS),
      );
      expect(counts(ctx.storage)).toEqual({
        commands: 0,
        blocks: 0,
        registrations: 0,
      });
      expect(
        await ownerRetentionWake(db, now + RECEIPT_RETENTION_MS),
      ).toBeNull();
    });
    clock.mockReturnValue(now + RECEIPT_RETENTION_MS);
    expect((await h.owner.send(h.principal, command)).outcome).toEqual({
      kind: "command_expired",
    });
  });

  it("rolls back actual message acceptance and pruning on durable alarm failure", async () => {
    const now = Date.now() + 60 * 24 * HOUR;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    const command = messageCommand(h.id, "atomic receipt");
    await runInDurableObject(h.owner, async (_instance, ctx) => {
      const db = openOwnerDatabase(ctx.storage);
      const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
      const failure = vi
        .spyOn(ctx.storage, "setAlarm")
        .mockImplementation(async (due) => {
          await setAlarm(due);
          throw new Error("alarm write failed");
        });
      try {
        await expect(
          mutateMessage(
            ctx.storage,
            db,
            h.principal,
            { kind: "send", command },
            Infinity,
          ),
        ).rejects.toThrow("alarm write failed");
      } finally {
        failure.mockRestore();
      }
      expect(counts(ctx.storage).commands).toBe(0);
      expect(
        ctx.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 0 });
      expect(ctx.storage.sql.exec("SELECT * FROM messages").toArray()).toEqual(
        [],
      );
      expect(await ctx.storage.getAlarm()).toBeNull();
      seed(ctx.storage, now, 1);
      await refreshOwnerAlarm(ctx, db);
      const wake = await ctx.storage.getAlarm();
      const deleteAlarm = ctx.storage.deleteAlarm.bind(ctx.storage);
      const pruningFailure = vi
        .spyOn(ctx.storage, "deleteAlarm")
        .mockImplementation(async () => {
          await deleteAlarm();
          throw new Error("pruning failed");
        });
      try {
        await expect(ownerAlarm(ctx, db)).rejects.toThrow("pruning failed");
      } finally {
        pruningFailure.mockRestore();
      }
      expect(counts(ctx.storage)).toEqual({
        commands: 1,
        blocks: 1,
        registrations: 1,
      });
      expect(await ctx.storage.getAlarm()).toBe(wake);
    });
    expect((await h.owner.send(h.principal, command)).outcome.kind).toBe(
      "accepted",
    );
  });

  it("does not retry completed cleanup when statistics maintenance fails", async () => {
    const h = await fixture();
    await runInDurableObject(h.owner, async (instance, ctx) => {
      seed(ctx.storage, Date.now() - 1_000, 1);
      await ctx.storage.setAlarm(Date.now() + 60_000);
      const native = ctx.storage.sql.exec.bind(ctx.storage.sql);
      vi.spyOn(ctx.storage.sql, "exec").mockImplementation(
        (query, ...bindings) => {
          if (query.startsWith("PRAGMA optimize"))
            throw new Error("injected optimization failure");
          return native(query, ...bindings);
        },
      );
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

      await instance.alarm();

      expect(counts(ctx.storage)).toEqual({
        commands: 0,
        blocks: 0,
        registrations: 0,
      });
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({ event: "owner_optimization_failed" }),
      );
    });
  });

  it("keeps failed local pruning observable at the platform retry boundary", async () => {
    const now = Date.now() + 60 * 24 * HOUR;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    await runInDurableObject(h.owner, async (instance, ctx) => {
      seed(ctx.storage, now, 1);
      await ctx.storage.setAlarm(now + 10_000);
      ctx.storage.sql.exec(
        "CREATE TRIGGER fail_prune BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'injected prune failure'); END",
      );
      try {
        for (let pass = 0; pass < 3; pass++) {
          clock.mockReturnValue(now + pass * 1_000);
          await expect(instance.alarm()).rejects.toThrow(
            "injected prune failure",
          );
          expect(counts(ctx.storage)).toEqual({
            commands: 1,
            blocks: 1,
            registrations: 1,
          });
          expect(await ctx.storage.getAlarm()).toBe(now + 10_000);
        }
      } finally {
        ctx.storage.sql.exec("DROP TRIGGER fail_prune");
      }
      await instance.alarm();
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(h.owner)).toBe(false);
  });

  it("retains a new receipt committed during external directory work and removes the provisional wake", async () => {
    const now = Date.now() + 60 * 24 * HOUR;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const h = await fixture();
    await runInDurableObject(h.owner, async (_instance, ctx) => {
      const db = openOwnerDatabase(ctx.storage);
      await ctx.storage.transaction(() => queueDirectorySync(ctx.storage));
      await ctx.storage.put(DIRECTORY_SYNC_AT, now);
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const drain = drainDirectorySync(ctx.storage, db, async () => {
        started();
        await gate;
      });
      await pending;
      try {
        expect(
          (
            await mutateMessage(
              ctx.storage,
              db,
              h.principal,
              { kind: "send", command: messageCommand(h.id, "concurrent") },
              Infinity,
            )
          ).kind,
        ).toBe("committed");
      } finally {
        release();
      }
      await drain;
      await refreshOwnerAlarm(ctx, db);
      expect(await ctx.storage.get(DIRECTORY_SYNC_AT)).toBeUndefined();
      expect(await ctx.storage.getAlarm()).toBe(
        retentionWake(now, RECEIPT_RETENTION_MS),
      );
    });
  });
});
