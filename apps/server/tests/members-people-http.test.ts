import { readHttpFailure } from "@tests/helpers/http";
import { server, alice, principal } from "@tests/helpers/messaging-owner";
import { observeSql } from "@tests/helpers/sql-observer";
import { describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import {
  PeopleResponseSchema,
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import {
  DirectoryOutcomeSchema,
  MembersOutcomeSchema,
} from "@vaskel/contracts/resources";
import {
  applicationHarness,
  decodeApplicationResponse,
  resourcePath,
  type ApplicationClient,
} from "@tests/helpers/application-harness";

async function members(client: ApplicationClient, path: string) {
  const response = await client.request(`${path}/members`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const result = await decodeApplicationResponse(
    response,
    MembersOutcomeSchema,
  );
  if (result.kind !== "members") throw new Error(result.kind);
  return result;
}

async function people(client: ApplicationClient, query = "") {
  const response = await client.request(
    `/api/people?query=${encodeURIComponent(query)}`,
  );
  expect(response.status).toBe(200);
  const result = await decodeApplicationResponse(
    response,
    PeopleResponseSchema,
  );
  if (result.kind !== "people") throw new Error(result.kind);
  return result;
}

describe("owner-authorized member and people HTTP contracts", () => {
  it("checks more than 100 distinct profile candidates and returns the first 40 authorized names", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const candidates = Array.from({ length: 120 }, (_, index) => ({
      userId: crypto.randomUUID(),
      displayName: `Person ${index.toString().padStart(3, "0")}`,
    }));
    await h.environment.IDENTITY_DB.batch(
      candidates.flatMap(({ userId, displayName }) => [
        h.environment.IDENTITY_DB.prepare(
          "INSERT INTO identity_user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, 'fixture', 'fixture')",
        ).bind(userId, displayName, `${userId}@example.invalid`),
        h.environment.IDENTITY_DB.prepare(
          "INSERT INTO resource_membership_index (resource_id,user_id) VALUES (?, ?)",
        ).bind(server.owner.id, userId),
      ]),
    );
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(server.owner.id),
      (_instance, state) => {
        state.storage.transactionSync(() => {
          for (const candidate of candidates)
            state.storage.sql.exec(
              "INSERT INTO members (user_id,role) VALUES (?, 'member')",
              candidate.userId,
            );
        });
      },
    );
    expect(await people(operator, "Person")).toEqual({
      kind: "people",
      people: candidates.slice(0, 40),
      partial: false,
    });
  });

  it("fails closed on unavailable owner authority and marks bounded candidate coverage as partial", async () => {
    const h = applicationHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(first.owner.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "ALTER TABLE members RENAME TO unavailable_members",
        );
      },
    );
    expect(await people(alice.member, "Operator")).toEqual({
      kind: "people",
      people: [],
      partial: true,
    });
    // Bogus navigation projections cannot grant membership, even when there
    // are enough candidate pairs and owners to exhaust both fanout bounds.
    const database = h.environment.IDENTITY_DB;
    const statements = Array.from({ length: 201 }, () => {
      const id = crypto.randomUUID();
      return [
        database
          .prepare(
            "INSERT INTO resource_directory (id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?, 'server', 'Candidate', ?, 'pending', 'fixture', 0)",
          )
          .bind(id, operator.profile!.userId),
        database
          .prepare(
            "INSERT INTO resource_membership_index (resource_id,user_id) VALUES (?, ?), (?, ?)",
          )
          .bind(id, alice.registered.userId, id, bob.registered.userId),
      ];
    }).flat();
    await database.batch(statements);
    expect(await people(alice.member, "Bob")).toEqual({
      kind: "people",
      people: [],
      partial: false,
    });
    await database
      .prepare(
        "UPDATE resource_directory SET lifecycle = 'ready' WHERE payload_hash = 'fixture'",
      )
      .run();
    expect(await people(alice.member, "Bob")).toEqual({
      kind: "people",
      people: [],
      partial: true,
    });
  });

  it("filters private-channel membership, retains owner administration visibility, and denies outsiders and removed members", async () => {
    const h = applicationHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    const hidden = crypto.randomUUID();
    const visible = crypto.randomUUID();
    let version = alice.joined.version;
    for (const channelId of [hidden, visible]) {
      const result = await decodeApplicationResponse(
        await operator.request(`/api/servers/${first.owner.id}/channels`, {
          channelId,
          name: "Private",
          private: true,
          expectedVersion: version,
        }),
        AdministrationOutcomeSchema,
      );
      if (result.kind !== "changed") throw new Error(result.kind);
      version = result.version;
    }
    for (const input of [
      { channelId: visible, userId: alice.registered.userId, allowed: true },
      { channelId: hidden, userId: operator.profile!.userId, allowed: false },
    ]) {
      const result = await decodeApplicationResponse(
        await operator.request(
          `/api/servers/${first.owner.id}/channel-member`,
          {
            ...input,
            expectedVersion: 1,
          },
        ),
        AdministrationOutcomeSchema,
      );
      if (result.kind !== "changed") throw new Error(result.kind);
      version += 1;
    }
    const ownerView = await members(operator, first.path);
    expect(ownerView.version).toBe(version);
    expect(ownerView.members).toEqual(
      expect.arrayContaining([
        { userId: operator.profile!.userId, role: "owner" },
        { userId: alice.registered.userId, role: "member" },
      ]),
    );
    expect(ownerView.channelMembers).toEqual(
      expect.arrayContaining([
        { channelId: hidden, userIds: [] },
        {
          channelId: visible,
          userIds: [operator.profile!.userId, alice.registered.userId].sort(),
        },
      ]),
    );
    const memberView = await members(alice.member, first.path);
    expect(memberView.version).toBe(version);
    expect(memberView.channelMembers).toEqual([
      {
        channelId: visible,
        userIds: [operator.profile!.userId, alice.registered.userId].sort(),
      },
    ]);
    for (const [client, status, code] of [
      [bob.member, 403, "FORBIDDEN"],
      [h.anonymous, 401, "UNAUTHENTICATED"],
    ] as const) {
      const response = await client.request(`${first.path}/members`);
      expect(response.status).toBe(status);
      expect(await readHttpFailure(response)).toMatchObject({ code });
    }
    const removed = await operator.request(
      `/api/servers/${first.owner.id}/remove-member`,
      {
        userId: alice.registered.userId,
        expectedVersion: version,
      },
    );
    expect(removed.status).toBe(200);
    await removed.text();
    const denied = await alice.member.request(`${first.path}/members`);
    expect(denied.status).toBe(403);
    expect(await readHttpFailure(denied)).toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await members(operator, first.path)).channelMembers.find(
        (row) => row.channelId === visible,
      )?.userIds,
    ).toEqual([operator.profile!.userId]);
  });

  it("limits literal name search to live shared membership despite stale caller and target D1 indices, while retaining by-ID profiles", async () => {
    const h = applicationHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    const specialName = `A%_\\${"東京".repeat(12)}`;
    const special = await h.registerMember(
      operator,
      first.owner.id,
      "special@example.invalid",
      specialName,
    );
    const initial = await people(alice.member);
    expect(initial.partial).toBe(false);
    expect(initial.people.map((person) => person.userId).sort()).toEqual(
      [operator.profile!.userId, special.registered.userId].sort(),
    );
    expect((await people(alice.member, "Bob")).people).toEqual([]);
    expect(
      (await people(alice.member, "operator")).people.map(
        (person) => person.userId,
      ),
    ).toEqual([operator.profile!.userId]);
    for (const query of ["%", "_", "\\", "東京".repeat(12)]) {
      expect((await people(alice.member, query)).people).toEqual([
        { userId: special.registered.userId, displayName: specialName },
      ]);
    }
    const removeSpecial = await decodeApplicationResponse(
      await operator.request(`/api/servers/${first.owner.id}/remove-member`, {
        userId: special.registered.userId,
        expectedVersion: special.joined.version,
      }),
      AdministrationOutcomeSchema,
    );
    if (removeSpecial.kind !== "changed") throw new Error(removeSpecial.kind);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT user_id FROM resource_membership_index WHERE resource_id = ? AND user_id = ?",
      )
        .bind(first.owner.id, special.registered.userId)
        .first("user_id"),
    ).toBe(special.registered.userId);
    expect((await people(alice.member, "%")).people).toEqual([]);
    const removeAlice = await operator.request(
      `/api/servers/${first.owner.id}/remove-member`,
      {
        userId: alice.registered.userId,
        expectedVersion: removeSpecial.version,
      },
    );
    expect(removeAlice.status).toBe(200);
    await removeAlice.text();
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT user_id FROM resource_membership_index WHERE resource_id = ? AND user_id = ?",
      )
        .bind(first.owner.id, alice.registered.userId)
        .first("user_id"),
    ).toBe(alice.registered.userId);
    expect(await people(alice.member)).toEqual({
      kind: "people",
      people: [],
      partial: false,
    });
    const byId = await decodeApplicationResponse(
      await alice.member.request(
        `/api/people?ids=${special.registered.userId},${bob.registered.userId}`,
      ),
      PeopleResponseSchema,
    );
    if (byId.kind !== "people") throw new Error(byId.kind);
    expect(byId.people.map((person) => person.userId).sort()).toEqual(
      [special.registered.userId, bob.registered.userId].sort(),
    );
    expect(byId.partial).toBe(false);
  });

  it("publishes canonical conversation participants and admits shared-conversation name discovery without exposing participants to outsiders", async () => {
    const h = applicationHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    expect((await people(alice.member, "Bob")).people).toEqual([]);
    const created = await decodeApplicationResponse(
      await alice.member.request("/api/conversations", {
        userId: bob.registered.userId,
      }),
      ResourceCreatedSchema,
    );
    if (created.kind !== "created") throw new Error(created.kind);
    const path = resourcePath(created.owner);
    const participantIds = [
      alice.registered.userId,
      bob.registered.userId,
    ].sort();
    const roster = await members(alice.member, path);
    expect(roster.members).toEqual(
      participantIds.map((userId) => ({
        userId,
        role: "member",
      })),
    );
    expect(roster.channelMembers).toEqual([]);
    for (const member of [alice.member, bob.member]) {
      const direct = await decodeApplicationResponse(
        await member.request(path),
        DirectoryOutcomeSchema,
      );
      expect(direct).toMatchObject({ kind: "directory", participantIds });
      const directory = await decodeApplicationResponse(
        await member.request("/api/directory"),
        ResourceDirectorySchema,
      );
      if (directory.kind !== "directory") throw new Error(directory.kind);
      expect(
        directory.resources.find(
          (resource) => resource.owner.id === created.owner.id,
        )?.participantIds,
      ).toEqual(participantIds);
      expect(
        directory.resources
          .filter((resource) => resource.owner.kind === "server")
          .every((resource) => resource.participantIds === undefined),
      ).toBe(true);
    }
    const denied = await operator.request(`${path}/members`);
    expect(denied.status).toBe(403);
    expect(await readHttpFailure(denied)).toMatchObject({ code: "FORBIDDEN" });
    expect((await people(alice.member, "Bob")).people).toEqual([
      { userId: bob.registered.userId, displayName: "Bob" },
    ]);
    expect(
      await decodeApplicationResponse(
        await alice.member.request(first.path),
        DirectoryOutcomeSchema,
      ),
    ).not.toHaveProperty("participantIds");
  });
});

it("intersects 200 raw People candidates without scanning unrelated roster growth", async () => {
  const { owner } = await server();
  const accountId = (index: number) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const all = Array.from({ length: 200 }, (_, i) => accountId(i + 1));
  const candidates = [
    ...all.slice(0, 197),
    all[0]!,
    "alice",
    accountId(10000),
  ].reverse();
  await runInDurableObject(owner, async (instance, state) => {
    const reads: number[] = [];
    for (const size of [256, 4096]) {
      state.storage.sql.exec(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT OR IGNORE INTO members(user_id,role) SELECT printf('00000000-0000-4000-8000-%012d',x),'member' FROM n`,
        size,
      );
      state.storage.sql.exec("DELETE FROM members WHERE user_id=?", all[100]);
      const observed = await observeSql(state.storage.sql, () =>
        instance.sharedPeople(alice(), candidates),
      );
      expect(observed.value).toEqual({
        kind: "shared_people",
        userIds: all.slice(0, 197).filter((id) => id !== all[100]),
      });
      reads.push(
        observed.statements.reduce(
          (sum, statement) => sum + statement.rowsRead,
          0,
        ),
      );
    }
    expect(reads[1]).toBe(reads[0]);
    expect(
      await instance.sharedPeople(alice(), Array(201).fill(all[0])),
    ).toEqual({ kind: "invalid_input" });
    expect(
      await instance.sharedPeople(
        principal("outsider"),
        Array(201).fill(all[0]),
      ),
    ).toEqual({ kind: "invalid_input" });
    expect(await instance.sharedPeople(alice(), [])).toEqual({
      kind: "shared_people",
      userIds: [],
    });
    expect(await instance.sharedPeople(principal("outsider"), [])).toEqual({
      kind: "forbidden",
    });
    expect(
      await instance.sharedPeople({ ...alice(), expiresAt: 0 }, []),
    ).toEqual({ kind: "unauthenticated" });
    state.storage.sql.exec("DELETE FROM members WHERE user_id='alice'");
    expect(await instance.sharedPeople(alice(), [])).toEqual({
      kind: "forbidden",
    });
  });
});

it("rejects the complete People intersection when a later native batch fails", async () => {
  const { owner } = await server();
  await runInDurableObject(owner, async (instance, state) => {
    const candidates = Array.from(
      { length: 130 },
      (_, i) => `member-${String(i).padStart(3, "0")}`,
    );
    for (const id of candidates)
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES (?,'member')",
        id,
      );
    const native = state.storage.sql.exec.bind(state.storage.sql);
    let batches = 0;
    const observer = vi
      .spyOn(state.storage.sql, "exec")
      .mockImplementation((query, ...bindings) => {
        if (query.includes('"user_id" in (') && ++batches === 2)
          native("SELECT * FROM missing_people_batch").toArray();
        return native(query, ...bindings);
      });
    try {
      await expect(instance.sharedPeople(alice(), candidates)).rejects.toThrow(
        /missing_people_batch/,
      );
      expect(batches).toBe(2);
    } finally {
      observer.mockRestore();
    }
    expect(await instance.sharedPeople(alice(), candidates)).toEqual({
      kind: "shared_people",
      userIds: candidates,
    });
  });
});
