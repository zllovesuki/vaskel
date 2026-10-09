import { readyAttachment } from "@tests/helpers/ready-attachment";
import { acceptedMessage as accepted } from "@tests/helpers/messaging";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CROSS_SEARCH_MAX_LIMIT,
  CrossSearchRequestSchema,
  MaterializeSearchOutcomeSchema,
  SearchCandidatesOutcomeSchema,
  compareSearchPositions,
  type SearchCandidate,
  type SearchCandidatesOutcome,
  type SearchPosition,
} from "@vaskel/contracts/search";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { mutateMessage } from "@/server/actors/shared/messages";
import type { Principal } from "@/server/domain/principal";

const principal = (userId = "alice"): Principal => ({
  userId,
  sessionId: `session-${userId}`,
  expiresAt: Date.now() + 60 * 60 * 1_000,
});
async function server(name = "Search server", id = crypto.randomUUID()) {
  const owner = env.SERVER_DO.getByName(id);
  expect(
    await owner.initialize({ serverId: id, name, ownerId: "alice" }),
  ).toMatchObject({ kind: "initialized" });
  return { id, owner };
}
type Server = Awaited<ReturnType<typeof server>>;
type CandidatePage = Extract<
  SearchCandidatesOutcome,
  { kind: "search_candidates" }
>;
function candidatePage(result: unknown): CandidatePage {
  const parsed = SearchCandidatesOutcomeSchema.parse(result);
  if (parsed.kind !== "search_candidates")
    throw new Error(`Expected candidates, received ${parsed.kind}`);
  return parsed;
}
function selected(page: CandidatePage, candidates = page.candidates) {
  return { candidates };
}

const command = (channelId: string) => ({
  commandId: crypto.randomUUID(),
  issuedAt: Date.now(),
  channelId,
});
async function send(
  h: Server,
  body = "Search needle 東京都",
  channelId = h.id,
  userId = "alice",
  attachmentIds: string[] = [],
) {
  return accepted(
    (
      await h.owner.send(principal(userId), {
        ...command(channelId),
        body,
        attachmentIds,
      })
    ).outcome,
  );
}
async function join(h: Server, userId = "bob") {
  const invite = await h.owner.createInvite(
    { ...principal(), invitePolicy: "members" },
    {
      expiresAt: Date.now() + 60_000,
    },
  );
  if (invite.kind !== "invite_created") throw new Error("Expected invitation");
  expect(
    await h.owner.redeemInvite(principal(userId), { token: invite.token }),
  ).toMatchObject({ kind: "joined" });
}
async function candidates(h: Server, userId = "alice", limit = 40) {
  return candidatePage(
    await h.owner.searchCandidates(principal(userId), {
      query: "needle",
      limit,
    }),
  );
}
async function privateChannel(h: Server) {
  const directory = await h.owner.directory(principal());
  if (directory.kind !== "directory") throw new Error("Expected directory");
  const channelId = crypto.randomUUID();
  expect(
    await h.owner.createChannel(principal(), {
      channelId,
      name: "Private documents",
      private: true,
      expectedVersion: directory.version,
    }),
  ).toMatchObject({ kind: "changed" });
  return channelId;
}

describe("two-phase server search on real workerd storage", () => {
  it("rolls back contentless FTS replacement with a failed edit receipt and recovers after eviction", async () => {
    const h = await server();
    const original = await send(h);
    const edit = {
      ...command(h.id),
      messageId: original.messageId,
      expectedVersion: 1,
      body: "Replacement text 数据库设计",
    };
    await runInDurableObject(h.owner, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER failed_edit AFTER INSERT ON command_receipts WHEN NEW.operation = 'edit' BEGIN SELECT RAISE(ABORT, 'after-FTS edit failure'); END",
      );
      await expect(
        mutateMessage(
          state.storage,
          openOwnerDatabase(state.storage),
          principal(),
          { kind: "edit", command: edit },
          8 * 1024 * 1024,
        ),
      ).rejects.toThrow("after-FTS edit failure");
    });
    await evictDurableObject(h.owner);
    expect((await candidates(h)).candidates).toMatchObject([
      { messageId: original.messageId, version: 1 },
    ]);
    expect(
      await h.owner.search(principal(), {
        channelId: h.id,
        query: "Replacement",
      }),
    ).toEqual({ kind: "matches", messages: [] });
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM command_receipts")
          .one(),
      ).toEqual({ count: 1 });
      expect(
        state.storage.sql
          .exec("SELECT message_id, body FROM message_fts")
          .toArray(),
      ).toEqual([{ message_id: original.messageId, body: null }]);
      state.storage.sql.exec("DROP TRIGGER failed_edit");
    });
    const retried = await h.owner.edit(principal(), edit);
    expect(retried).toMatchObject({
      kind: "accepted",
      receipt: { version: 2, sequence: 2 },
    });
    expect(await h.owner.edit(principal(), edit)).toEqual(retried);
    expect((await candidates(h)).candidates).toEqual([]);
    expect(
      await h.owner.search(principal(), {
        channelId: h.id,
        query: "数据库设计",
      }),
    ).toMatchObject({
      kind: "matches",
      messages: [{ id: original.messageId, body: edit.body }],
    });
    await h.owner.deleteMessage(principal(), {
      ...command(h.id),
      messageId: original.messageId,
      expectedVersion: 2,
    });
    expect(
      await h.owner.search(principal(), {
        channelId: h.id,
        query: "数据库设计",
      }),
    ).toEqual({ kind: "matches", messages: [] });
  });

  it("preserves channel-local server search and participant-authorized DM search", async () => {
    const h = await server();
    const channelId = await privateChannel(h);
    const publicMessage = await send(h);
    const privateMessage = await send(h, "needle 東京都", channelId);
    expect(
      await h.owner.search(principal(), { channelId: h.id, query: "東京都" }),
    ).toMatchObject({
      kind: "matches",
      messages: [{ id: publicMessage.messageId }],
    });
    expect(
      await h.owner.search(principal(), { channelId, query: "東京都" }),
    ).toMatchObject({
      kind: "matches",
      messages: [{ id: privateMessage.messageId }],
    });
    const id = crypto.randomUUID();
    const dm = env.CONVERSATION_DO.getByName(id);
    await dm.initialize({
      conversationId: id,
      participantIds: ["alice", "bob"],
    });
    const receipt = accepted(
      (await dm.send(principal(), { ...command(id), body: "Private 𠮷野家" }))
        .outcome,
    );
    expect(
      await dm.search(principal("bob"), { channelId: id, query: "𠮷野家" }),
    ).toMatchObject({
      kind: "matches",
      messages: [{ id: receipt.messageId, body: "Private 𠮷野家" }],
    });
    expect(
      await dm.search(principal("outsider"), {
        channelId: id,
        query: "𠮷野家",
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("applies literal mixed CJK matching and code-point bounds without query fallback", async () => {
    const h = await server();
    const body =
      '東京都 数据库設計 𠮷野家 alpha OR beta say "hello" cafe\u0301';
    const first = await send(h, body);
    await send(h, "alpha independent beta 東京");
    for (const query of [
      " 東京都 ",
      "数据库設計",
      "𠮷野家",
      "alpha OR beta",
      'say "hello"',
      "cafe\u0301",
    ]) {
      const request = CrossSearchRequestSchema.parse({ query });
      const page = candidatePage(
        await h.owner.searchCandidates(principal(), request),
      );
      expect(page.candidates.map((key) => key.messageId)).toEqual([
        first.messageId,
      ]);
    }
    for (const query of ["東京", "𠮷野", " "])
      expect(
        await h.owner.searchCandidates(principal(), { query, limit: 20 }),
      ).toEqual({ kind: "query_too_short", minimum: 3 });
    expect(
      candidatePage(
        await h.owner.searchCandidates(principal(), {
          query: "café",
          limit: 20,
        }),
      ).candidates,
    ).toEqual([]);

    const maximum = "𠮷".repeat(256);
    const longMessage = await send(h, maximum);
    const request = CrossSearchRequestSchema.parse({ query: maximum });
    expect(request.query.length).toBe(512);
    expect(
      candidatePage(await h.owner.searchCandidates(principal(), request))
        .candidates,
    ).toMatchObject([{ messageId: longMessage.messageId }]);
    for (const input of [
      { query: `${maximum}𠮷` },
      { query: `${" ".repeat(1_025)}needle` },
      { query: "needle", channelId: h.id },
      { query: "needle", limit: 41 },
      { query: "needle", cursor: "x".repeat(4_097) },
      { query: "needle", scopes: [] },
    ])
      expect(CrossSearchRequestSchema.safeParse(input).success).toBe(false);
  });

  it("filters private channels and tombstones before lookahead, including a denied server owner", async () => {
    const h = await server();
    await join(h);
    const channelId = await privateChannel(h);
    await h.owner.setChannelMember(principal(), {
      channelId,
      userId: "bob",
      allowed: true,
      expectedVersion: 1,
    });
    const first = await send(h);
    const second = await send(h);
    const hidden = await send(h, "needle hidden body", channelId, "bob");
    const deleted = await send(h, "needle deleted body");
    await h.owner.deleteMessage(principal(), {
      ...command(h.id),
      messageId: deleted.messageId,
      expectedVersion: 1,
    });
    await h.owner.setChannelMember(principal(), {
      channelId,
      userId: "alice",
      allowed: false,
      expectedVersion: 2,
    });
    const page = await candidates(h, "alice", 1);
    expect(page.candidates.map((key) => key.messageId)).toEqual([
      second.messageId,
      first.messageId,
    ]);
    expect(JSON.stringify(page)).not.toContain(hidden.messageId);
    expect(JSON.stringify(page)).not.toContain(deleted.messageId);
    expect(
      await h.owner.searchCandidates(principal(), {
        query: "needle",
        channelId,
        limit: 1,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await h.owner.searchCandidates(principal("outsider"), {
        query: "needle",
        limit: 1,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await h.owner.searchCandidates(
        { ...principal(), expiresAt: 0 },
        {
          query: "needle",
          limit: 1,
        },
      ),
    ).toEqual({ kind: "unauthenticated" });
    expect(
      await h.owner.searchCandidates(principal(), {
        query: "needle",
        channelId: crypto.randomUUID(),
        limit: 1,
      }),
    ).toEqual({ kind: "not_found" });
    const allowed = candidatePage(
      await h.owner.searchCandidates(principal("bob"), {
        query: "needle",
        channelId,
        limit: 1,
      }),
    );
    expect(allowed.candidates).toMatchObject([{ messageId: hidden.messageId }]);
  });

  it("materializes selected current files and authoritative labels only in the final read", async () => {
    const h = await server("Authoritative server label");
    const reservation = await readyAttachment(h.owner, principal(), {
      ...command(h.id),
      filename: "私有資料.txt",
      byteLength: 3,
    });
    const receipt = await send(h, "needle file caption", h.id, "alice", [
      reservation.fileId,
    ]);
    const page = await candidates(h);
    expect(Object.keys(page.candidates[0]!).sort()).toEqual([
      "createdAt",
      "createdSequence",
      "messageId",
      "version",
    ]);
    // Search does not read unrelated occupancy, even if that projection is invalid.
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO channel_occupancy(channel_id, revision, summary) VALUES (?, 1, ?)",
        h.id,
        "invalid occupancy fixture",
      );
    });
    const read = MaterializeSearchOutcomeSchema.parse(
      await h.owner.materializeSearch(principal(), selected(page)),
    );
    expect(read).toMatchObject({
      kind: "search_materialized",
      serverId: h.id,
      serverName: "Authoritative server label",
      hits: [
        {
          channel: { id: h.id, name: "general" },
          message: {
            id: receipt.messageId,
            body: "needle file caption",
            attachments: [
              { fileId: reservation.fileId, filename: "私有資料.txt" },
            ],
          },
        },
      ],
    });
    await h.owner.setAttachmentIncident(
      { ...principal(), isOperator: true },
      reservation.fileId,
      { quarantined: true, preserve: true, incidentReference: "search-test" },
    );
    expect(
      await h.owner.materializeSearch(principal(), selected(page)),
    ).toMatchObject({
      kind: "search_materialized",
      hits: [{ message: { body: "needle file caption", attachments: [] } }],
    });
  });

  it("keeps readable selections through metadata, membership and unrelated permission changes", async () => {
    const h = await server();
    const message = await send(h);
    const channelId = crypto.randomUUID();
    const changed = { kind: "changed" };
    const unchanged = [
      async () =>
        expect(
          await h.owner.createChannel(principal(), {
            channelId,
            name: "Private",
            private: true,
            expectedVersion: 1,
          }),
        ).toMatchObject(changed),
      () => join(h),
      async () =>
        expect(
          await h.owner.updateChannel(principal(), {
            channelId,
            topic: "Only the topic changed",
            expectedVersion: 1,
          }),
        ).toMatchObject(changed),
      async () =>
        expect(
          await h.owner.rename(principal(), {
            name: "Renamed mid-search",
            expectedVersion: 4,
          }),
        ).toMatchObject(changed),
    ];
    for (const operation of unchanged) {
      const before = await candidates(h);
      await operation();
      expect(
        await h.owner.materializeSearch(principal(), selected(before)),
      ).toMatchObject({
        kind: "search_materialized",
        hits: [{ message: { id: message.messageId } }],
      });
      expect(
        await h.owner.searchCandidates(principal(), {
          query: "needle",
          limit: 20,
        }),
      ).toMatchObject({ kind: "search_candidates" });
    }
    const advancing = [
      async () =>
        expect(
          await h.owner.setChannelMember(principal(), {
            channelId,
            userId: "bob",
            allowed: true,
            expectedVersion: 2,
          }),
        ).toMatchObject(changed),
      async () =>
        expect(
          await h.owner.setChannelMember(principal(), {
            channelId,
            userId: "bob",
            allowed: false,
            expectedVersion: 3,
          }),
        ).toMatchObject(changed),
      async () =>
        expect(
          await h.owner.setRole(principal(), {
            userId: "bob",
            role: "moderator",
            expectedVersion: 7,
          }),
        ).toMatchObject(changed),
      async () =>
        expect(
          await h.owner.removeMember(principal(), {
            userId: "bob",
            expectedVersion: 8,
          }),
        ).toMatchObject(changed),
    ];
    for (const operation of advancing) {
      const before = await candidates(h);
      await operation();
      expect(
        await h.owner.materializeSearch(principal(), selected(before)),
      ).toMatchObject({
        kind: "search_materialized",
        hits: [{ message: { id: message.messageId } }],
      });
      expect(
        await h.owner.searchCandidates(principal(), {
          query: "needle",
          limit: 20,
        }),
      ).toMatchObject({ kind: "search_candidates" });
    }
  });

  it("omits selected private bodies after revocation and denies reads after membership removal", async () => {
    const h = await server();
    await join(h);
    const channelId = await privateChannel(h);
    await h.owner.setChannelMember(principal(), {
      channelId,
      userId: "bob",
      allowed: true,
      expectedVersion: 1,
    });
    const visible = await send(h);
    await send(h, "needle revoked body", channelId);
    const page = await candidates(h, "bob");
    expect(page.candidates).toHaveLength(2);
    await h.owner.setChannelMember(principal(), {
      channelId,
      userId: "bob",
      allowed: false,
      expectedVersion: 2,
    });
    expect(
      await h.owner.materializeSearch(principal("bob"), selected(page)),
    ).toMatchObject({
      kind: "search_materialized",
      hits: [{ message: { id: visible.messageId } }],
    });
    expect(
      await h.owner.materializeSearch(principal("bob"), {
        ...selected(page),
        channelId,
      }),
    ).toEqual({ kind: "forbidden" });
    const directory = await h.owner.directory(principal());
    if (directory.kind !== "directory") throw new Error(directory.kind);
    await h.owner.removeMember(principal(), {
      userId: "bob",
      expectedVersion: directory.version,
    });
    expect(
      await h.owner.materializeSearch(principal("bob"), selected(page)),
    ).toEqual({ kind: "forbidden" });
  });

  it("omits changed rows while retaining unchanged selections and creation-position checks", async () => {
    const h = await server();
    const first = await send(h);
    const second = await send(h);
    const initial = await candidates(h);
    await h.owner.edit(principal(), {
      ...command(h.id),
      messageId: first.messageId,
      expectedVersion: 1,
      body: "needle still matches but changed",
    });
    expect(
      await h.owner.materializeSearch(principal(), selected(initial)),
    ).toMatchObject({
      kind: "search_materialized",
      hits: [{ message: { id: second.messageId } }],
    });
    const beforeDelete = await candidates(h);
    await h.owner.deleteMessage(principal(), {
      ...command(h.id),
      messageId: second.messageId,
      expectedVersion: 1,
    });
    expect(
      await h.owner.materializeSearch(principal(), selected(beforeDelete)),
    ).toMatchObject({
      kind: "search_materialized",
      hits: [{ message: { id: first.messageId, version: 2 } }],
    });
    const current = await candidates(h);
    for (const changed of [
      {
        ...current.candidates[0]!,
        createdAt: current.candidates[0]!.createdAt + 1,
      },
      {
        ...current.candidates[0]!,
        createdSequence: current.candidates[0]!.createdSequence + 1,
      },
    ])
      expect(
        await h.owner.materializeSearch(
          principal(),
          selected(current, [changed]),
        ),
      ).toMatchObject({ kind: "search_materialized", hits: [] });
    await runInDurableObject(h.owner, (_, state) =>
      state.storage.sql.exec(
        "UPDATE owner_state SET generation=?",
        crypto.randomUUID(),
      ),
    );
    expect(
      await h.owner.materializeSearch(principal(), selected(current)),
    ).toMatchObject({
      kind: "search_materialized",
      hits: [{ message: { id: first.messageId } }],
    });
  });

  it("keeps immutable creation order across three pages and caps owner lookahead at 41 keys", async () => {
    const h = await server();
    const receipts = [];
    for (let index = 0; index < 47; index++) receipts.push(await send(h));
    // Fix a timestamp tie while preserving real owner-local creation sequences.
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec("UPDATE messages SET created_at = ?", 1_000);
    });
    await h.owner.edit(principal(), {
      ...command(h.id),
      messageId: receipts[0]!.messageId,
      expectedVersion: 1,
      body: "needle old creation edited most recently",
    });
    expect(
      (await candidates(h, "alice", CROSS_SEARCH_MAX_LIMIT)).candidates,
    ).toHaveLength(41);
    let before: SearchPosition | undefined;
    const emitted: string[] = [];
    const pages: number[] = [];
    do {
      const page = candidatePage(
        await h.owner.searchCandidates(principal(), {
          query: "needle",
          channelId: h.id,
          limit: 20,
          ...(before ? { before } : {}),
        }),
      );
      const keys = page.candidates.slice(0, 20);
      const materialized = MaterializeSearchOutcomeSchema.parse(
        await h.owner.materializeSearch(principal(), {
          ...selected(page, keys),
          channelId: h.id,
        }),
      );
      if (materialized.kind !== "search_materialized")
        throw new Error("Final read");
      pages.push(materialized.hits.length);
      emitted.push(...materialized.hits.map((hit) => hit.message.id));
      const last = keys.at(-1);
      before =
        page.candidates.length > 20 && last
          ? { ...last, serverId: h.id }
          : undefined;
    } while (before);
    expect(pages).toEqual([20, 20, 7]);
    expect(emitted).toEqual(
      receipts.map((receipt) => receipt.messageId).reverse(),
    );
  });

  it("uses the full shared frontier for interleaved owners and binary server/message ties", async () => {
    const first = await server("First", "10000000-0000-4000-8000-000000000001");
    const second = await server(
      "Second",
      "20000000-0000-4000-8000-000000000001",
    );
    const positions: SearchPosition[] = [];
    for (let index = 0; index < 4; index++) {
      for (const h of [first, second]) {
        const receipt = await send(h);
        positions.push({
          serverId: h.id,
          messageId: receipt.messageId,
          createdAt: 1_000,
          createdSequence: receipt.sequence,
        });
      }
    }
    for (const h of [first, second])
      await runInDurableObject(h.owner, (_instance, state) => {
        state.storage.sql.exec("UPDATE messages SET created_at = ?", 1_000);
      });
    const ordered = positions.sort(compareSearchPositions);
    const emitted: SearchPosition[] = [];
    let before: SearchPosition | undefined;
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const all: (SearchCandidate & { serverId: string })[] = [];
      for (const h of [first, second]) {
        const page = candidatePage(
          await h.owner.searchCandidates(principal(), {
            query: "needle",
            limit: 2,
            ...(before ? { before } : {}),
          }),
        );
        all.push(...page.candidates.map((key) => ({ ...key, serverId: h.id })));
      }
      const keys = all.sort(compareSearchPositions).slice(0, 2);
      emitted.push(...keys.map(({ version: _version, ...key }) => key));
      before = keys.at(-1);
    }
    expect(emitted).toEqual(ordered);
    const ownLast = (await candidates(first)).candidates[0]!;
    const beforeOwnId = { ...ownLast, serverId: first.id, messageId: "0" };
    const afterOwnId = { ...ownLast, serverId: first.id, messageId: "z" };
    const below = async (position: SearchPosition) =>
      candidatePage(
        await first.owner.searchCandidates(principal(), {
          query: "needle",
          limit: 40,
          before: position,
        }),
      ).candidates;
    expect((await below(beforeOwnId)).map((key) => key.messageId)).toContain(
      ownLast.messageId,
    );
    expect((await below(afterOwnId)).map((key) => key.messageId)).not.toContain(
      ownLast.messageId,
    );
  });
});
