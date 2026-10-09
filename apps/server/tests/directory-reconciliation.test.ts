import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import {
  drainDirectorySync,
  publishMembershipBatch,
} from "@/server/actors/shared/directory-sync";
import { DIRECTORY_SYNC_AT } from "@/server/actors/shared/directory-sync";
import { refreshOwnerAlarm } from "@/server/actors/shared/maintenance";
import { redeemInvite } from "@/server/actors/server/invitations";
import { ResourceDirectorySchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import {
  applicationHarness,
  decodeApplicationResponse,
} from "@tests/helpers/application-harness";

const principal = (userId: string) => ({
  userId,
  sessionId: crypto.randomUUID(),
  expiresAt: Date.now() + 60_000,
});

async function fixture() {
  const id = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({ serverId: id, ownerId, name: "Reconciliation" });
  const invite = await owner.createInvite(
    { ...principal(ownerId), invitePolicy: "members" },
    { expiresAt: Date.now() + 60_000, maxUses: 100 },
  );
  if (invite.kind !== "invite_created") throw new Error(invite.kind);
  return { owner, id, ownerId, token: invite.token };
}

describe("membership directory reconciliation", () => {
  it("acknowledges HTTP admission and serves authorized metadata before durable reconciliation publishes discovery", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const first = await h.createServer(operator);
    const alice = await h.registerMember(operator, first.owner.id);
    const outsider = await h.registerMember(
      operator,
      first.owner.id,
      "outsider@example.invalid",
      "Outsider",
    );
    const target = await h.createServer(operator, "Target");
    const invitation = await h.invite(operator, target.owner.id);
    const owner = env.SERVER_DO.getByName(target.owner.id);
    const command = { token: invitation.token };
    const hints = vi.fn();
    const getByName = env.SERVER_DO.getByName.bind(env.SERVER_DO);
    const binding = vi
      .spyOn(env.SERVER_DO, "getByName")
      .mockImplementation((name, options) => {
        const stub = getByName(name, options);
        if (name !== target.owner.id) return stub;
        return new Proxy(stub, {
          get(target, property) {
            if (property === "redeemInvite")
              return (...args: Parameters<typeof target.redeemInvite>) =>
                runInDurableObject(owner, async (instance, state) => {
                  const result = await instance.redeemInvite(...args);
                  // Delay delivery to expose the committed, unpublished state.
                  await state.storage.setAlarm(Date.now() + 60_000);
                  return result;
                });
            if (property === "publishDirectoryHints") return hints;
            return Reflect.get(target, property, target);
          },
        });
      });
    let accepted;
    try {
      accepted = await decodeApplicationResponse(
        await alice.member.request("/api/invites/join", command),
        AdministrationOutcomeSchema,
      );
      expect(hints).not.toHaveBeenCalled();
    } finally {
      binding.mockRestore();
    }
    expect(accepted.kind).toBe("joined");
    // The join response does not publish membership itself.
    const discovered = async () => {
      const result = await decodeApplicationResponse(
        await alice.member.request("/api/directory"),
        ResourceDirectorySchema,
      );
      if (result.kind !== "directory") throw new Error(result.kind);
      return result.resources.map((resource) => resource.owner.id);
    };
    expect(await discovered()).not.toContain(target.owner.id);
    const queries: string[] = [];
    const nativeSession = env.IDENTITY_DB.withSession.bind(env.IDENTITY_DB);
    const sessions = vi
      .spyOn(env.IDENTITY_DB, "withSession")
      .mockImplementation((anchor) => {
        const session = nativeSession(anchor);
        const prepare = session.prepare.bind(session);
        session.prepare = (query) => {
          queries.push(query);
          return prepare(query);
        };
        return session;
      });
    try {
      const response = await alice.member.request(target.path);
      expect(response.status).toBe(200);
      expect(
        await decodeApplicationResponse(response, DirectoryOutcomeSchema),
      ).toMatchObject({ kind: "directory", owner: target.owner });
      expect((await outsider.member.request(target.path)).status).toBe(403);
      expect(
        queries.some((query) => query.includes("resource_membership_index")),
      ).toBe(false);
    } finally {
      sessions.mockRestore();
    }
    // Even after response background work settles, direct reads publish no index rows.
    expect(await discovered()).not.toContain(target.owner.id);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT user_id FROM resource_membership_index WHERE resource_id = ? AND user_id IN (?, ?)",
      )
        .bind(
          target.owner.id,
          alice.registered.userId,
          outsider.registered.userId,
        )
        .all(),
    ).toMatchObject({ results: [] });
    await owner.revokeInvite(principal(operator.profile!.userId), command);
    await evictDurableObject(owner);
    expect(await runDurableObjectAlarm(owner)).toBe(true);
    expect(await discovered()).toContain(target.owner.id);
    expect(
      await decodeApplicationResponse(
        await alice.member.request("/api/invites/join", command),
        AdministrationOutcomeSchema,
      ),
    ).toEqual(accepted);
    await runInDurableObject(owner, async (_instance, state) => {
      expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("rolls membership, receipt, KV deadline and alarm back together if arming recovery fails", async () => {
    const { owner, token } = await fixture();
    await runInDurableObject(owner, async (_instance, state) => {
      const user = principal(crypto.randomUUID());
      const database = openOwnerDatabase(state.storage);
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      const alarm = vi
        .spyOn(state.storage, "setAlarm")
        .mockImplementationOnce(async (...args) => {
          await setAlarm(...args);
          throw new Error("alarm write failed");
        });
      try {
        await expect(
          redeemInvite(state.storage, database, user, { token }, Infinity),
        ).rejects.toThrow("alarm write failed");
      } finally {
        alarm.mockRestore();
      }
      expect(
        await database
          .selectFrom("members")
          .selectAll()
          .where("user_id", "=", user.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await database.selectFrom("invite_joins").selectAll().execute(),
      ).toEqual([]);
      expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(
        await redeemInvite(state.storage, database, user, { token }, Infinity),
      ).toMatchObject({ kind: "joined", version: 2 });
    });
  });

  it("coalesces joins, ignores rejected invitations, and skips absent or future work on unrelated alarms", async () => {
    const { owner, token, ownerId } = await fixture();
    await runInDurableObject(owner, async (_instance, state) => {
      const database = openOwnerDatabase(state.storage);
      const publish = vi.fn(
        async (_id: string, _users: readonly string[]) => {},
      );
      await drainDirectorySync(state.storage, database, publish);
      expect(publish).not.toHaveBeenCalled();
      expect(
        await redeemInvite(
          state.storage,
          database,
          principal(crypto.randomUUID()),
          { token: `${crypto.randomUUID()}.invalid` },
          Infinity,
        ),
      ).toMatchObject({ kind: "not_found" });
      expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBeUndefined();
      const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
      for (const id of ids) {
        expect(
          await redeemInvite(
            state.storage,
            database,
            principal(id),
            { token },
            Infinity,
          ),
        ).toMatchObject({ kind: "joined" });
        // A later join cannot postpone already-due work.
        if (id === ids[0]) await state.storage.put(DIRECTORY_SYNC_AT, 1);
      }
      expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBe(1);
      expect(await drainDirectorySync(state.storage, database, publish)).toBe(
        true,
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[1]).toEqual([ownerId, ...ids].sort());
      await refreshOwnerAlarm(state, database);
      expect(await state.storage.getAlarm()).toBeNull();
      await drainDirectorySync(state.storage, database, publish);
      await state.storage.put(DIRECTORY_SYNC_AT, Date.now() + 60_000);
      await refreshOwnerAlarm(state, database);
      await drainDirectorySync(state.storage, database, publish);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it("retains another pass when a join commits during external publication", async () => {
    const { owner, token } = await fixture();
    await runInDurableObject(owner, async (_instance, state) => {
      const database = openOwnerDatabase(state.storage);
      await redeemInvite(
        state.storage,
        database,
        principal(crypto.randomUUID()),
        { token },
        Infinity,
      );
      const late = principal(crypto.randomUUID());
      const publish = vi.fn(async (_id: string, users: readonly string[]) => {
        expect(users).not.toContain(late.userId);
        await redeemInvite(state.storage, database, late, { token }, Infinity);
      });
      expect(await drainDirectorySync(state.storage, database, publish)).toBe(
        false,
      );
      expect(
        await state.storage.get<number>(DIRECTORY_SYNC_AT),
      ).toBeLessThanOrEqual(Date.now());
      const next = vi.fn(async (_id: string, users: readonly string[]) => {
        expect(users).toContain(late.userId);
      });
      expect(await drainDirectorySync(state.storage, database, next)).toBe(
        true,
      );
      expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBeUndefined();
    });
  });

  it.each(["failure", "lost acknowledgement"] as const)(
    "retries idempotently after D1 %s with a durable recovery wakeup",
    async (failure) => {
      const h = applicationHarness();
      const operator = await h.bootstrap();
      const first = await h.createServer(operator);
      const alice = await h.registerMember(operator, first.owner.id);
      const server = await h.createServer(operator, "Target");
      const invite = await h.invite(operator, server.owner.id);
      const owner = env.SERVER_DO.getByName(server.owner.id);
      await runInDurableObject(owner, (instance, state) =>
        state.blockConcurrencyWhile(async () => {
          const database = openOwnerDatabase(state.storage);
          expect(
            await instance.redeemInvite(principal(alice.registered.userId), {
              token: invite.token,
            }),
          ).toMatchObject({ kind: "joined" });
          const before = Date.now();
          const publish = vi.fn(
            async (id: string, users: readonly string[]) => {
              if (failure === "lost acknowledgement")
                await publishMembershipBatch(env, id, users);
              throw new Error("D1 unavailable");
            },
          );
          expect(
            await drainDirectorySync(state.storage, database, publish),
          ).toBe(false);
          const retryAt = await state.storage.get<number>(DIRECTORY_SYNC_AT);
          expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
          await refreshOwnerAlarm(state, database);
          expect(await state.storage.getAlarm()).toBe(retryAt);
          await drainDirectorySync(state.storage, database, publish);
          expect(publish).toHaveBeenCalledTimes(1);
          await state.storage.put(DIRECTORY_SYNC_AT, 0);
        }),
      );
      await evictDurableObject(owner);
      expect(await runDurableObjectAlarm(owner)).toBe(true);
      const rows = await env.IDENTITY_DB.prepare(
        "SELECT user_id FROM resource_membership_index WHERE resource_id = ? ORDER BY user_id",
      )
        .bind(server.owner.id)
        .all<{ user_id: string }>();
      expect(rows.results.map((row) => row.user_id)).toEqual(
        [operator.profile!.userId, alice.registered.userId].sort(),
      );
    },
  );

  it("repairs interrupted partial batches without per-member progress", async () => {
    const { owner, id: resourceId, token, ownerId } = await fixture();
    await runInDurableObject(owner, (_instance, state) =>
      state.blockConcurrencyWhile(async () => {
        const database = openOwnerDatabase(state.storage);
        const ids = Array.from({ length: 85 }, () => crypto.randomUUID());
        await env.IDENTITY_DB.batch([
          ...[ownerId, ...ids].map((id) =>
            env.IDENTITY_DB.prepare(
              "INSERT INTO identity_user (id, name, email, createdAt, updatedAt) VALUES (?, 'Member', ?, '2026-09-19', '2026-09-19')",
            ).bind(id, `${id}@example.invalid`),
          ),
          env.IDENTITY_DB.prepare(
            "INSERT INTO resource_directory (id, kind, name, creator_id, lifecycle, payload_hash, created_at) VALUES (?, 'server', 'Test', ?, 'ready', 'test', 0)",
          ).bind(resourceId, ownerId),
        ]);
        for (const id of ids)
          await redeemInvite(
            state.storage,
            database,
            principal(id),
            { token },
            Infinity,
          );
        const published = async () =>
          (
            await env.IDENTITY_DB.prepare(
              "SELECT user_id FROM resource_membership_index WHERE resource_id = ? ORDER BY user_id",
            )
              .bind(resourceId)
              .all<{ user_id: string }>()
          ).results.map((row) => row.user_id);
        let calls = 0;
        const publish = async (id: string, users: readonly string[]) => {
          expect(users.length).toBeLessThanOrEqual(40);
          if (++calls === 2) throw new Error("interrupted second batch");
          await publishMembershipBatch(env, id, users);
        };
        expect(await drainDirectorySync(state.storage, database, publish)).toBe(
          false,
        );
        expect(await published()).toHaveLength(40);
        await state.storage.put(DIRECTORY_SYNC_AT, 0);
        expect(await drainDirectorySync(state.storage, database, publish)).toBe(
          true,
        );
        expect(await published()).toEqual([ownerId, ...ids].sort());
        expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBeUndefined();
      }),
    );
  });

  it("keeps a timed-out publication fenced until settlement and never acknowledges its late result", async () => {
    const { owner, token } = await fixture();
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        const database = openOwnerDatabase(state.storage);
        await instance.redeemInvite(principal(crypto.randomUUID()), { token });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        const publish = vi.fn(async () => {
          await pending;
        });
        try {
          expect(
            await drainDirectorySync(state.storage, database, publish),
          ).toBe(false);
          expect(
            await state.storage.get<number>(DIRECTORY_SYNC_AT),
          ).toBeGreaterThan(Date.now());
          await state.storage.put(DIRECTORY_SYNC_AT, 0);
          expect(
            await drainDirectorySync(state.storage, database, publish),
          ).toBe(false);
          expect(publish).toHaveBeenCalledTimes(1);
        } finally {
          release();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await state.storage.get(DIRECTORY_SYNC_AT)).toBeDefined();
        await state.storage.put(DIRECTORY_SYNC_AT, 0);
        expect(await drainDirectorySync(state.storage, database, publish)).toBe(
          true,
        );
        expect(publish).toHaveBeenCalledTimes(2);
      }),
    );
  });
});
