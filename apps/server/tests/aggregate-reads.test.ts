import { barrier } from "@tests/helpers/barrier";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  PeopleResponseSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import { ActivityPageSchema } from "@vaskel/contracts/activity";
import {
  BlockListSchema,
  BlockStatusesSchema,
} from "@vaskel/contracts/blocking";
import { OperatorUsageOutcomeSchema } from "@vaskel/contracts/instance";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal } from "@/server/directory/owners";
import { listResources } from "@/server/directory/resources";
import { BoundedWork } from "@/server/actors/shared/bounded-work";
import { directConversationId } from "@/server/directory/identifiers";
import {
  applicationHarness,
  decodeApplicationResponse,
} from "@tests/helpers/application-harness";
import { blockCommand } from "@tests/helpers/blocking-harness";

/** Hold a real owner transaction so subsequent native read RPCs cannot finish. */
async function holdOwner(
  owner:
    | ReturnType<typeof env.SERVER_DO.getByName>
    | ReturnType<typeof env.CONVERSATION_DO.getByName>,
) {
  let entered = false;
  const gate = barrier();
  const holding = runInDurableObject(owner, async (_, state) => {
    await state.storage.transaction(async () => {
      state.storage.sql.exec("SELECT version FROM owner_state").toArray();
      entered = true;
      await gate.promise;
    });
  });
  await expect.poll(() => entered).toBe(true);
  return async () => {
    gate.release();
    await holding;
  };
}

describe("bounded aggregate native owner reads", () => {
  it("reports expired owner authority as incomplete and definitive absence as complete", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const principal = await getPrincipal(
      new Request(`${env.AUTH_ORIGIN}/api/directory`, {
        headers: { Cookie: operator.cookie },
      }),
      env,
    );
    if (!principal) throw new Error("Missing fixture principal");
    const delayed = { ...principal, verifiedAt: Date.now() - 31_000 };
    const owner = env.SERVER_DO.getByName(server.owner.id);
    expect(await owner.directory(actorPrincipal(delayed))).toEqual({
      kind: "unauthenticated",
    });
    expect(await listResources(env, delayed, undefined)).toMatchObject({
      resources: [],
      partial: true,
      nextCursor: null,
    });
    expect(await listResources(env, principal, undefined)).toMatchObject({
      resources: [{ owner: server.owner }],
      partial: false,
    });
    await runInDurableObject(owner, (_, state) => {
      state.storage.sql.exec("DELETE FROM members");
    });
    expect(await owner.directory(actorPrincipal(principal))).toEqual({
      kind: "forbidden",
    });
    expect(await listResources(env, principal, undefined)).toMatchObject({
      resources: [],
      partial: false,
    });
    await runInDurableObject(owner, (_, state) => {
      state.storage.sql.exec("DELETE FROM owner_state");
    });
    expect(await owner.directory(actorPrincipal(principal))).toEqual({
      kind: "not_found",
    });
    expect(await listResources(env, principal, undefined)).toMatchObject({
      resources: [],
      partial: false,
    });
  });

  it("returns healthy directory, activity, people and administration results before a stalled owner settles, then recovers on refetch", async () => {
    const h = applicationHarness();
    const { operator, first, second, alice, bob } = await h.twoServers();
    const read = async () => {
      const [directory, activity, people, usage] = await Promise.all([
        operator
          .request("/api/directory")
          .then((response) =>
            decodeApplicationResponse(response, ResourceDirectorySchema),
          ),
        operator
          .request("/api/account/activity")
          .then((response) =>
            decodeApplicationResponse(response, ActivityPageSchema),
          ),
        operator
          .request("/api/people?query=")
          .then((response) =>
            decodeApplicationResponse(response, PeopleResponseSchema),
          ),
        operator
          .request("/api/operator/usage")
          .then((response) =>
            decodeApplicationResponse(response, OperatorUsageOutcomeSchema),
          ),
      ]);
      if (
        directory.kind !== "directory" ||
        activity.kind !== "activity" ||
        usage.kind !== "usage" ||
        people.kind !== "people"
      )
        throw new Error("Aggregate read failed");
      return { directory, activity, people, usage };
    };
    const release = await holdOwner(env.SERVER_DO.getByName(first.owner.id));
    try {
      const started = Date.now();
      const result = await read();
      expect(Date.now() - started).toBeLessThan(3_500);
      expect(result.directory).toMatchObject({
        partial: true,
        nextCursor: null,
      });
      expect(result.directory.resources.map((item) => item.owner.id)).toEqual([
        second.owner.id,
      ]);
      expect(result.activity).toMatchObject({
        partial: true,
        unavailableOwners: [first.owner],
      });
      expect(result.activity.owners.map((item) => item.owner.id)).toEqual([
        second.owner.id,
      ]);
      expect(result.people).toMatchObject({ partial: true });
      expect(result.people.people.map((person) => person.userId)).toEqual([
        bob.member.profile!.userId,
      ]);
      expect(result.usage).toMatchObject({ partial: true });
      expect(result.usage.owners.map((item) => item.owner.id)).toEqual([
        second.owner.id,
      ]);
    } finally {
      await release();
    }
    const recovered = await read();
    expect(recovered.directory.partial).toBe(false);
    expect(recovered.directory.resources).toHaveLength(2);
    expect(recovered.activity).toMatchObject({
      partial: false,
      unavailableOwners: [],
    });
    expect(recovered.activity.owners).toHaveLength(2);
    expect(recovered.people.partial).toBe(false);
    expect(
      new Set(recovered.people.people.map((person) => person.userId)),
    ).toEqual(
      new Set([alice.member.profile!.userId, bob.member.profile!.userId]),
    );
    expect(recovered.usage.partial).toBe(false);
    expect(recovered.usage.owners).toHaveLength(2);
  });

  it("never reports a stalled blocked pair as unblocked and recovers both list and resolve coverage", async () => {
    const h = applicationHarness();
    const { operator, alice, bob } = await h.twoServers();
    const targets = [alice.member.profile!.userId, bob.member.profile!.userId];
    for (const target of targets)
      expect(
        (
          await operator.request(
            `/api/account/blocks/${target}`,
            blockCommand(),
            { method: "PUT" },
          )
        ).status,
      ).toBe(200);
    const read = async () => {
      const [list, resolved] = await Promise.all([
        operator
          .request("/api/account/blocks")
          .then((response) =>
            decodeApplicationResponse(response, BlockListSchema),
          ),
        operator
          .request("/api/account/blocks/resolve", { targetIds: targets })
          .then((response) =>
            decodeApplicationResponse(response, BlockStatusesSchema),
          ),
      ]);
      if (list.kind !== "blocks" || resolved.kind !== "block_statuses")
        throw new Error("Block aggregate failed");
      return { list, resolved };
    };
    const id = await directConversationId(
      operator.profile!.userId,
      targets[0]!,
    );
    const release = await holdOwner(env.CONVERSATION_DO.getByName(id));
    try {
      const started = Date.now();
      const result = await read();
      expect(Date.now() - started).toBeLessThan(3_500);
      for (const page of [result.list, result.resolved])
        expect(page).toMatchObject({
          partial: true,
          unavailableTargetIds: [targets[0]],
        });
      expect(result.list.blocks.map((status) => status.targetId)).toEqual([
        targets[1],
      ]);
      expect(result.resolved.statuses).toMatchObject([
        { targetId: targets[1], blocked: true },
      ]);
    } finally {
      await release();
    }
    const recovered = await read();
    for (const page of [recovered.list, recovered.resolved])
      expect(page).toMatchObject({ partial: false, unavailableTargetIds: [] });
    expect(recovered.list.blocks).toHaveLength(2);
    expect(recovered.resolved.statuses).toHaveLength(2);
    expect(recovered.resolved.statuses.every((status) => status.blocked)).toBe(
      true,
    );
  });

  it("marks unattempted owners unavailable when timed-out native reads retain every concurrency slot", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const servers = [];
    for (let index = 0; index < 5; index++)
      servers.push(await h.createServer(operator));
    servers.sort((a, b) => a.owner.id.localeCompare(b.owner.id));
    const releases = await Promise.all(
      servers
        .slice(0, 4)
        .map((server) => holdOwner(env.SERVER_DO.getByName(server.owner.id))),
    );
    const read = async () =>
      decodeApplicationResponse(
        await operator.request("/api/account/activity"),
        ActivityPageSchema,
      );
    try {
      const started = Date.now();
      const result = await read();
      expect(Date.now() - started).toBeLessThan(6_500);
      expect(result).toMatchObject({
        kind: "activity",
        partial: true,
        owners: [],
        unavailableOwners: servers.map((server) => server.owner),
        nextCursor: null,
      });
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
    const recovered = await read();
    expect(recovered).toMatchObject({ partial: false, unavailableOwners: [] });
    if (recovered.kind !== "activity") throw new Error(recovered.kind);
    expect(recovered.owners).toHaveLength(5);
  });

  it("uses one deadline across successive reads and ignores late results without releasing the underlying slot", async () => {
    const pool = new BoundedWork(1, 100);
    const deadline = Date.now() + 90;
    const started: number[] = [];
    const results = await pool.map(
      [1, 2, 3, 4],
      async (entry) => {
        started.push(entry);
        await new Promise((resolve) => setTimeout(resolve, 55));
        return entry;
      },
      deadline,
    );
    expect(results).toEqual([
      { ok: true, value: 1 },
      { ok: false },
      { ok: false },
      { ok: false },
    ]);
    expect(started).toEqual([1, 2]);
    expect(await pool.run(async () => 5, Date.now() + 100)).toEqual({
      ok: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(results[1]).toEqual({ ok: false });
    expect(await pool.run(async () => 6, Date.now() + 100)).toEqual({
      ok: true,
      value: 6,
    });
  });
});
