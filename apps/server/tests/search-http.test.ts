import { readHttpFailure } from "@tests/helpers/http";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import {
  CrossSearchResponseSchema,
  SearchCandidatesRequestSchema,
  MaterializeSearchRequestSchema,
  compareSearchPositions,
  type CrossSearchRequest,
  type MaterializeSearchOutcome,
  type MaterializeSearchRequest,
  type SearchCandidatesOutcome,
  type SearchCandidatesRequest,
} from "@vaskel/contracts/search";
import type { Principal } from "@/server/domain/principal";
import { encodeSearchCursor, decodeSearchCursor } from "@/server/search/cursor";
import {
  applicationHarness,
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
  type ApplicationClient,
} from "@tests/helpers/application-harness";
import {
  attachmentHarness,
  messagingResult,
} from "@tests/helpers/attachment-harness";

const orderedId = (index: number) =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const query = "needle 東京";
function principal(client: ApplicationClient): Principal {
  return {
    userId: client.profile!.userId,
    sessionId: "fixture",
    expiresAt: Date.now() + 60_000,
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function search(
  client: ApplicationClient,
  request: CrossSearchRequest = { query },
  status = 200,
) {
  const response = await client.request("/api/account/search", request);
  expect(response.status).toBe(status);
  return decodeApplicationResponse(response, CrossSearchResponseSchema);
}
async function matches(
  client: ApplicationClient,
  request: CrossSearchRequest = { query },
) {
  const result = await search(client, request);
  if (result.kind !== "cross_matches") throw new Error(result.kind);
  return result;
}
function cursorPayload(token: string) {
  const position = decodeSearchCursor(token);
  if (!position) throw new Error("Invalid fixture cursor");
  return position;
}

/** Every result still comes from the real native actor; hooks delay or fail only transport. */
function interceptReads(hooks: {
  candidates?: (
    serverId: string,
    input: SearchCandidatesRequest,
    read: () => Promise<SearchCandidatesOutcome>,
  ) => Promise<unknown>;
  materialize?: (
    serverId: string,
    input: MaterializeSearchRequest,
    read: () => Promise<MaterializeSearchOutcome>,
  ) => Promise<unknown>;
}) {
  const original = env.SERVER_DO.getByName.bind(env.SERVER_DO);
  return vi
    .spyOn(env.SERVER_DO, "getByName")
    .mockImplementation((name, options) => {
      const stub = original(name, options);
      return new Proxy(stub, {
        get(target, property) {
          if (property === "searchCandidates" && hooks.candidates) {
            return (context: Principal, input: SearchCandidatesRequest) =>
              hooks.candidates!(
                name,
                SearchCandidatesRequestSchema.parse(input),
                async () => await target.searchCandidates(context, input),
              );
          }
          if (property === "materializeSearch" && hooks.materialize) {
            return (context: Principal, input: MaterializeSearchRequest) =>
              hooks.materialize!(
                name,
                MaterializeSearchRequestSchema.parse(input),
                async () => await target.materializeSearch(context, input),
              );
          }
          return Reflect.get(target, property, target);
        },
      });
    });
}

async function fixtureServer(
  client: ApplicationClient,
  index: number,
  ownerId = client.profile!.userId,
) {
  const id = orderedId(index);
  const owner = env.SERVER_DO.getByName(id);
  const initialized = await owner.initialize({
    serverId: id,
    name: `Authoritative server ${index}`,
    ownerId,
  });
  if (initialized.kind !== "initialized") throw new Error(initialized.kind);
  await env.IDENTITY_DB.batch([
    env.IDENTITY_DB.prepare(
      "INSERT INTO resource_directory(id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?, 'server', 'Untrusted directory label', ?, 'ready', 'fixture', 0)",
    ).bind(id, client.profile!.userId),
    env.IDENTITY_DB.prepare(
      "INSERT INTO resource_membership_index(resource_id,user_id) VALUES (?, ?)",
    ).bind(id, client.profile!.userId),
  ]);
  return {
    id,
    owner,
    channelId: initialized.channelId,
    path: resourcePath({ kind: "server", id }),
  };
}

async function fixtureMessages(
  client: ApplicationClient,
  server: Awaited<ReturnType<typeof fixtureServer>>,
  times: number[],
) {
  const keys = [];
  for (const [index, createdAt] of times.entries()) {
    const result = (
      await server.owner.send(
        principal(client),
        messageCommand(server.channelId, `${query} ${server.id} ${index}`),
      )
    ).outcome;
    if (result.kind !== "accepted") throw new Error(result.kind);
    const messageId = result.receipt.messageId;
    await runInDurableObject(server.owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE messages SET created_at = ? WHERE id = ?",
        createdAt,
        messageId,
      );
    });
    keys.push({
      serverId: server.id,
      messageId,
      createdAt,
      createdSequence: result.receipt.sequence,
    });
  }
  return keys;
}

describe("cross-server search HTTP and native owner composition", () => {
  it("validates Unicode and literal queries, keeps local search, and scopes directly despite a missing directory hint", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const server = await h.createServer(client);
    const body = '東京 fox "OR" 😀😀😀';
    await messagingResult(
      await client.request(
        `${server.path}/send`,
        messageCommand(server.channelId, body),
      ),
    );
    await expect(search(client, { query: "😀😀" }, 400)).rejects.toMatchObject({
      code: "QUERY_TOO_SHORT",
      data: { kind: "query_too_short", minimum: 3 },
    });
    expect(
      (await matches(client, { query: "  😀😀😀  " })).hits[0]?.message.body,
    ).toBe(body);
    expect((await matches(client, { query: 'fox "OR"' })).hits).toHaveLength(1);
    expect((await matches(client, { query: "fox OR absent" })).hits).toEqual(
      [],
    );
    expect((await matches(client, { query: "😀".repeat(256) })).hits).toEqual(
      [],
    );
    for (const input of [
      { query: "😀".repeat(257) },
      { query: " ".repeat(1024) + "abc" },
      { query, channelId: server.channelId },
      { query, limit: 41 },
      { query, cursor: "x".repeat(4097) },
      { query, extra: true },
    ])
      await expect(search(client, input, 400)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    expect(
      (
        await messagingResult(
          await client.request(`${server.path}/search`, {
            channelId: server.channelId,
            query: "fox",
          }),
        )
      ).kind,
    ).toBe("matches");
    await env.IDENTITY_DB.prepare(
      "DELETE FROM resource_membership_index WHERE resource_id = ?",
    )
      .bind(server.owner.id)
      .run();
    expect((await matches(client, { query: "fox" })).hits).toEqual([]);
    const scoped = await matches(client, {
      query: "fox",
      serverId: server.owner.id,
      channelId: server.channelId,
    });
    expect(scoped.hits).toHaveLength(1);
    expect(scoped.hits).toMatchObject([
      { serverId: server.owner.id, serverName: server.name },
    ]);
    expect(
      (await h.anonymous.request("/api/account/search", { query })).status,
    ).toBe(401);
  });

  it("emits every interleaved key through multiple actual page boundaries with immutable ties and only selected-owner materialization", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const a = await fixtureServer(client, 1);
    const b = await fixtureServer(client, 2);
    const c = await fixtureServer(client, 3);
    const aKeys = await fixtureMessages(client, a, [90, 70, 50, 30, 10]);
    const bKeys = await fixtureMessages(client, b, [90, 70, 50, 30, 10]);
    const cKeys = await fixtureMessages(client, c, [20, 0]);
    expect(
      (
        await a.owner.edit(principal(client), {
          ...messageCommand(a.channelId, `${query} edited last in time`),
          messageId: aKeys.at(-1)!.messageId,
          expectedVersion: 1,
        })
      ).kind,
    ).toBe("accepted");
    const expected = [...aKeys, ...bKeys, ...cKeys].sort(
      compareSearchPositions,
    );
    const hydrated: { id: string; count: number }[] = [];
    const transport = interceptReads({
      materialize: async (id, input, read) => {
        hydrated.push({ id, count: input.candidates.length });
        return read();
      },
    });
    try {
      const emitted: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const hydrationStart = hydrated.length;
        const page = await matches(client, {
          query,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        pages++;
        emitted.push(...page.hits.map((hit) => hit.message.id));
        expect(page.coverage).toEqual({ limited: false, unavailable: false });
        if (pages === 1)
          expect(hydrated.some((read) => read.id === c.id)).toBe(false);
        expect(hydrated.every((read) => read.count > 0)).toBe(true);
        expect(
          hydrated
            .slice(hydrationStart)
            .reduce((total, entry) => total + entry.count, 0),
        ).toBe(2);
        if (page.nextCursor) {
          const payload = cursorPayload(page.nextCursor);
          expect(payload.messageId).toBe(page.hits.at(-1)?.message.id);
        }
        cursor = page.nextCursor ?? undefined;
        expect(pages).toBeLessThan(10);
      } while (cursor);
      expect(pages).toBe(6);
      expect(emitted).toEqual(expected.map((key) => key.messageId));
      expect(new Set(emitted).size).toBe(12);
      const scoped: string[] = [];
      let scopedCursor: string | undefined;
      let scopedPages = 0;
      do {
        const page = await matches(client, {
          query,
          limit: 2,
          serverId: a.id,
          ...(scopedCursor ? { cursor: scopedCursor } : {}),
        });
        scoped.push(...page.hits.map((hit) => hit.message.id));
        scopedPages++;
        scopedCursor = page.nextCursor ?? undefined;
      } while (scopedCursor);
      expect(scopedPages).toBe(3);
      expect(scoped).toEqual(aKeys.map((key) => key.messageId));
    } finally {
      transport.mockRestore();
    }
  });

  it("rechecks private access after another owner's held candidate read before releasing a body, filename or cursor", async () => {
    const h = attachmentHarness();
    const client = await h.bootstrap();
    const a = await fixtureServer(client, 1);
    const b = await fixtureServer(client, 2);
    const privateId = crypto.randomUUID();
    expect(
      (
        await a.owner.createChannel(principal(client), {
          channelId: privateId,
          name: "Private",
          private: true,
          expectedVersion: 1,
        })
      ).kind,
    ).toBe("changed");
    const file = await h.upload(
      client,
      a.path,
      privateId,
      "private-proof.txt",
      new TextEncoder().encode("private bytes"),
    );
    await messagingResult(
      await client.request(`${a.path}/send`, {
        ...messageCommand(privateId, query),
        attachmentIds: [file.fileId],
      }),
    );
    expect((await matches(client)).hits[0]?.message.attachments).toMatchObject([
      { fileId: file.fileId, filename: "private-proof.txt" },
    ]);
    const admittedA = gate();
    const heldB = gate();
    const release = gate();
    const transport = interceptReads({
      candidates: async (id, _input, read) => {
        const result = await read();
        if (id === a.id) admittedA.resolve();
        if (id === b.id) {
          heldB.resolve();
          await release.promise;
        }
        return result;
      },
    });
    try {
      const pending = client.request("/api/account/search", {
        query,
        limit: 1,
      });
      await Promise.all([admittedA.promise, heldB.promise]);
      expect(
        (
          await a.owner.setChannelMember(principal(client), {
            channelId: privateId,
            userId: client.profile!.userId,
            allowed: false,
            expectedVersion: 1,
          })
        ).kind,
      ).toBe("changed");
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(
        await decodeApplicationResponse(response, CrossSearchResponseSchema),
      ).toMatchObject({ kind: "cross_matches", hits: [], nextCursor: null });
    } finally {
      release.resolve();
      transport.mockRestore();
    }
    expect((await matches(client)).hits).toEqual([]);
    expect(
      await matches(client, { query, serverId: a.id, channelId: privateId }),
    ).toMatchObject({ hits: [], deniedServerIds: [a.id], nextCursor: null });
  });

  it.each(["edit", "delete", "generation"] as const)(
    "omits changed selections without resetting other owners during fanout: %s",
    async (change) => {
      const h = applicationHarness();
      const client = await h.bootstrap();
      const a = await fixtureServer(client, 1);
      const b = await fixtureServer(client, 2);
      const [key] = await fixtureMessages(client, a, [100]);
      const stable = await fixtureMessages(client, b, [90]);
      const admittedA = gate();
      const heldB = gate();
      const release = gate();
      const transport = interceptReads({
        candidates: async (id, _input, read) => {
          const result = await read();
          if (id === a.id) admittedA.resolve();
          if (id === b.id) {
            heldB.resolve();
            await release.promise;
          }
          return result;
        },
      });
      try {
        const pending = client.request("/api/account/search", { query });
        await Promise.all([admittedA.promise, heldB.promise]);
        if (change === "generation") {
          await runInDurableObject(a.owner, (_instance, state) => {
            state.storage.sql.exec(
              "UPDATE owner_state SET generation = ?",
              crypto.randomUUID(),
            );
          });
        } else {
          const command = {
            ...messageCommand(a.channelId, "no longer matches"),
            messageId: key!.messageId,
            expectedVersion: 1,
          };
          const result =
            change === "edit"
              ? await a.owner.edit(principal(client), command)
              : await a.owner.deleteMessage(principal(client), command);
          expect(result.kind).toBe("accepted");
        }
        release.resolve();
        const response = await pending;
        expect(response.status).toBe(200);
        const result = await decodeApplicationResponse(
          response,
          CrossSearchResponseSchema,
        );
        if (result.kind !== "cross_matches") throw new Error(result.kind);
        expect(result.hits.map((hit) => hit.message.id)).toEqual([
          ...(change === "generation" ? [key!.messageId] : []),
          stable[0]!.messageId,
        ]);
      } finally {
        release.resolve();
        transport.mockRestore();
      }
    },
  );

  it("advances empty incomplete pages through their selection and rediscovers recovered owners", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const a = await fixtureServer(client, 1);
    const b = await fixtureServer(client, 2);
    const aKeys = await fixtureMessages(client, a, [110, 100, 90, 80]);
    const bKeys = await fixtureMessages(client, b, [70, 60]);
    const fail = () =>
      interceptReads({
        materialize: async (id, _, read) => {
          if (id === a.id) throw new Error("fixture failure");
          return read();
        },
      });
    let transport = fail();
    let first;
    try {
      first = await matches(client, { query, limit: 2 });
    } finally {
      transport.mockRestore();
    }
    expect(first).toMatchObject({
      hits: [],
      unavailableServerIds: [a.id],
      deniedServerIds: [],
      coverage: { limited: false, unavailable: true },
    });
    expect(cursorPayload(first.nextCursor!)).toEqual(aKeys[1]);
    const recovered = await matches(client, {
      query,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(recovered.hits.map((hit) => hit.message.id)).toEqual(
      aKeys.slice(2).map((key) => key.messageId),
    );
    expect(recovered.coverage.unavailable).toBe(false);
    transport = fail();
    let empty;
    try {
      empty = await matches(client, {
        query,
        limit: 2,
        cursor: first.nextCursor!,
      });
    } finally {
      transport.mockRestore();
    }
    expect(empty.hits).toEqual([]);
    expect(cursorPayload(empty.nextCursor!)).toEqual(aKeys[3]);
    expect(
      (
        await matches(client, { query, limit: 2, cursor: empty.nextCursor! })
      ).hits.map((hit) => hit.message.id),
    ).toEqual(bKeys.map((key) => key.messageId));
    expect(
      (await matches(client, { query, limit: 2 })).hits.map(
        (hit) => hit.message.id,
      ),
    ).toEqual(aKeys.slice(0, 2).map((key) => key.messageId));
    transport = interceptReads({
      candidates: async () => {
        throw new Error("No frontier available");
      },
    });
    try {
      expect(await matches(client)).toMatchObject({
        hits: [],
        nextCursor: null,
        unavailableServerIds: [a.id, b.id],
        coverage: { unavailable: true },
      });
    } finally {
      transport.mockRestore();
    }
  });

  it("advances short pages beyond omitted selected keys without skipping the next candidate window", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const a = await fixtureServer(client, 1);
    const b = await fixtureServer(client, 2);
    const aKeys = await fixtureMessages(client, a, [80, 60]);
    const bKeys = await fixtureMessages(client, b, [90, 70]);
    const transport = interceptReads({
      materialize: async (id, _input, read) => {
        if (id === a.id) throw new Error("fixture final-read failure");
        return read();
      },
    });
    try {
      const first = await matches(client, { query, limit: 2 });
      expect(first.hits.map((hit) => hit.message.id)).toEqual([
        bKeys[0]!.messageId,
      ]);
      expect(cursorPayload(first.nextCursor!).messageId).toBe(
        aKeys[0]!.messageId,
      );
      const second = await matches(client, {
        query,
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.hits.map((hit) => hit.message.id)).toEqual([
        bKeys[1]!.messageId,
      ]);
      expect(second.coverage.unavailable).toBe(true);
      expect(second.nextCursor).toBeNull();
    } finally {
      transport.mockRestore();
    }
  });

  it("admits eight authorized owners past refused directory candidates and distinguishes denied owners from RPC failures", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const servers: Awaited<ReturnType<typeof fixtureServer>>[] = [];
    for (let index = 0; index < 12; index++) {
      const server = await fixtureServer(
        client,
        index,
        index === 2 ? "someone-else" : client.profile!.userId,
      );
      servers.push(server);
      if (index !== 2) await fixtureMessages(client, server, [100 - index]);
    }
    const candidateCalls: string[] = [];
    const materializeCalls: { id: string; count: number }[] = [];
    const transport = interceptReads({
      candidates: async (id, _input, read) => {
        candidateCalls.push(id);
        if (id === servers[3]!.id) throw new Error("private owner failure");
        if (id === servers[4]!.id) throw new Error("RPC connection lost");
        return read();
      },
      materialize: async (id, input, read) => {
        materializeCalls.push({ id, count: input.candidates.length });
        return read();
      },
    });
    try {
      const first = await matches(client, { query, limit: 2 });
      expect(candidateCalls.sort()).toEqual(
        servers.slice(0, 11).map((server) => server.id),
      );
      expect(materializeCalls).toHaveLength(2);
      expect(
        materializeCalls.reduce((total, call) => total + call.count, 0),
      ).toBe(2);
      expect(first.deniedServerIds).toEqual([servers[2]!.id]);
      expect(first.unavailableServerIds).toEqual([
        servers[3]!.id,
        servers[4]!.id,
      ]);
      expect(
        first.hits.every((hit) => hit.serverName.startsWith("Authoritative")),
      ).toBe(true);
      expect(first.coverage).toEqual({ limited: true, unavailable: true });
      candidateCalls.length = 0;
      await matches(client, { query, limit: 2, cursor: first.nextCursor! });
      expect(candidateCalls.sort()).toEqual(
        servers.slice(0, 11).map((server) => server.id),
      );
      const scoped = await matches(client, { query, serverId: servers[9]!.id });
      expect(scoped.hits).toHaveLength(1);
      expect(scoped.coverage).toEqual({ limited: false, unavailable: false });
      expect(
        await matches(client, { query, serverId: servers[2]!.id }),
      ).toMatchObject({
        hits: [],
        deniedServerIds: [servers[2]!.id],
        coverage: { limited: false, unavailable: false },
      });
    } finally {
      transport.mockRestore();
    }
  });

  it("bounds discovery at fifty candidates while stale hints leave room for authorized owners", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const servers = [];
    for (let index = 0; index < 51; index++) {
      const server = await fixtureServer(
        client,
        index,
        index < 43 ? "departed-owner" : client.profile!.userId,
      );
      servers.push(server);
      if (index >= 43) await fixtureMessages(client, server, [100 - index]);
    }
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    const transport = interceptReads({
      candidates: async (id, _, read) => {
        calls.push(id);
        maximum = Math.max(maximum, ++active);
        try {
          return await read();
        } finally {
          active--;
        }
      },
    });
    try {
      const result = await matches(client);
      expect(calls).toEqual(servers.slice(0, 50).map((server) => server.id));
      expect(maximum).toBeLessThanOrEqual(4);
      expect(result.deniedServerIds).toEqual(
        servers.slice(0, 43).map((server) => server.id),
      );
      expect(result.hits.map((hit) => hit.serverId)).toEqual(
        servers.slice(43, 50).map((server) => server.id),
      );
      expect(result.coverage).toEqual({ limited: true, unavailable: false });
      expect(
        (await matches(client, { query, serverId: servers[50]!.id })).hits,
      ).toHaveLength(1);
    } finally {
      transport.mockRestore();
    }
  });

  it.each([3, 4])(
    "retains %i late candidate slots during candidate discovery",
    async (heldCount) => {
      const h = applicationHarness();
      const client = await h.bootstrap();
      for (let index = 0; index < 8; index++)
        await fixtureServer(client, index);
      const release = gate();
      const late = gate();
      let called = 0;
      let active = 0;
      let maximum = 0;
      let materialized = 0;
      const transport = interceptReads({
        candidates: async (id, _input, read) => {
          called++;
          maximum = Math.max(maximum, ++active);
          const result = await read();
          if (Number(id.slice(-12)) < heldCount) await release.promise;
          if (--active === 0) late.resolve();
          return result;
        },
        materialize: async (_id, _input, read) => {
          materialized++;
          maximum = Math.max(maximum, ++active);
          try {
            return await read();
          } finally {
            active--;
          }
        },
      });
      try {
        const response = await matches(client);
        expect(response).toMatchObject({
          kind: "cross_matches",
          hits: [],
          nextCursor: null,
          coverage: { limited: false, unavailable: true },
        });
        expect(called).toBe(heldCount === 4 ? 4 : 8);
        expect(maximum).toBe(4);
        expect(materialized).toBe(0); // No owner had selected keys.
        const unavailable = [...response.unavailableServerIds];
        release.resolve();
        await late.promise;
        expect(response.unavailableServerIds).toEqual(unavailable);
      } finally {
        release.resolve();
        transport.mockRestore();
      }
    },
    15_000,
  );

  it("validates creation cursors independently of query/session while rechecking access and carries account bookmark policy", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const server = await fixtureServer(client, 1);
    await fixtureMessages(client, server, [30, 20, 10]);
    const sessions = vi.spyOn(env.IDENTITY_DB, "withSession");
    const bookmark = "search-consistency-floor";
    const response = await client.request(
      "/api/account/search",
      { query, limit: 1 },
      { bookmark },
    );
    expect(response.status).toBe(200);
    expect(sessions).toHaveBeenCalledWith(bookmark);
    expect(sessions).toHaveBeenCalledWith("first-primary");
    sessions.mockRestore();
    const first = await decodeApplicationResponse(
      response,
      CrossSearchResponseSchema,
    );
    if (first.kind !== "cross_matches" || !first.nextCursor)
      throw new Error("Missing fixture cursor");
    const modified = encodeSearchCursor({
      ...cursorPayload(first.nextCursor),
      createdAt: 999,
    });
    const secondSession = await h.signIn(
      h.client(),
      "operator@example.invalid",
    );
    let called = 0;
    const transport = interceptReads({
      candidates: async (_id, _input, read) => {
        called++;
        return read();
      },
    });
    try {
      for (const cursor of ["malformed.cursor!", "e30", "x".repeat(4097)])
        await expect(
          search(client, { query, cursor }, 400),
        ).rejects.toMatchObject({
          code: cursor.length > 4096 ? "BAD_REQUEST" : "INVALID_INPUT",
        });
      const wrongAccount = await client.request(
        "/api/account/search",
        { query },
        { headers: { [EXPECTED_ACCOUNT_HEADER]: "another-account" } },
      );
      expect(wrongAccount.status).toBe(401);
      expect(await readHttpFailure(wrongAccount)).toMatchObject({
        code: "UNAUTHENTICATED",
      });
      expect(called).toBe(0);
    } finally {
      transport.mockRestore();
    }
    expect(
      (
        await matches(secondSession, {
          query,
          limit: 2,
          cursor: first.nextCursor,
        })
      ).hits,
    ).toHaveLength(2);
    expect(
      (
        await matches(client, {
          query,
          limit: 2,
          serverId: server.id,
          cursor: modified,
        })
      ).hits,
    ).toHaveLength(2);
    await runInDurableObject(server.owner, (_, state) => {
      state.storage.sql.exec("DELETE FROM members");
    });
    expect(
      await matches(client, { query, limit: 1, cursor: first.nextCursor }),
    ).toMatchObject({ hits: [], deniedServerIds: [server.id] });
  });

  it("checks the same cookie session again on primary after owner reads and rejects revocation before HTTP release", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const server = await fixtureServer(client, 1);
    await fixtureMessages(client, server, [100]);
    const held = gate();
    const release = gate();
    const transport = interceptReads({
      materialize: async (_id, _input, read) => {
        const result = await read();
        held.resolve();
        await release.promise;
        return result;
      },
    });
    try {
      const pending = client.request("/api/account/search", { query });
      await held.promise;
      expect((await client.request("/api/identity/sign-out", {})).status).toBe(
        200,
      );
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "UNAUTHENTICATED",
      });
    } finally {
      release.resolve();
      transport.mockRestore();
    }
  });
});
