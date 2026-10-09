import { readHttpFailure } from "@tests/helpers/http";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  BlockListSchema,
  BlockOutcomeSchema,
  BlockStatusesSchema,
  type BlockOutcome,
} from "@vaskel/contracts/blocking";
import {
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import { directConversationId } from "@/server/directory/identifiers";
import { getPrincipal } from "@/server/auth/principal";
import { getBlock } from "@/server/directory/blocks";
import type { Principal } from "@/server/domain/principal";
import {
  attachmentHarness,
  attachmentResult,
  messagingResult,
} from "@tests/helpers/attachment-harness";
import {
  applicationHarness,
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
} from "@tests/helpers/application-harness";
import { blockCommand } from "@tests/helpers/blocking-harness";

describe("authenticated pair blocking HTTP contracts", () => {
  it("keeps negative and positive status reads read-only while preserving refusals", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const alice = (await h.registerMember(operator, server.owner.id)).member;
    const bob = (
      await h.registerMember(
        operator,
        server.owner.id,
        "bob@example.invalid",
        "Bob",
      )
    ).member;
    const userId = operator.profile!.userId;
    await env.IDENTITY_DB.exec(
      "CREATE TABLE audit_candidate_writes (kind TEXT NOT NULL)",
    );
    await env.IDENTITY_DB.exec(
      "CREATE TRIGGER audit_candidate_insert AFTER INSERT ON block_candidates BEGIN INSERT INTO audit_candidate_writes VALUES ('insert'); END",
    );
    await env.IDENTITY_DB.exec(
      "CREATE TRIGGER audit_candidate_update AFTER UPDATE ON block_candidates BEGIN INSERT INTO audit_candidate_writes VALUES ('update'); END",
    );
    const counts = async () => ({
      candidates: (await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM block_candidates WHERE user_id = ?",
      )
        .bind(userId)
        .first<{ count: number }>())!.count,
      writes: (await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_candidate_writes",
      ).first<{ count: number }>())!.count,
    });
    expect(await counts()).toEqual({ candidates: 0, writes: 0 });
    const personPath = `/api/account/blocks/${alice.profile!.userId}`;
    for (let index = 0; index < 3; index++) {
      const response = await operator.request(personPath);
      expect(response.status).toBe(200);
      expect(
        await decodeApplicationResponse(response, BlockOutcomeSchema),
      ).toMatchObject({
        kind: "block_status",
        status: { blocked: false, revision: 0, canSend: true },
      });
    }
    expect(await counts()).toEqual({ candidates: 0, writes: 0 });
    const conversation = await decodeApplicationResponse(
      await operator.request("/api/conversations", {
        userId: bob.profile!.userId,
      }),
      ResourceCreatedSchema,
    );
    if (conversation.kind !== "created") throw new Error(conversation.kind);
    const directPath = `${resourcePath(conversation.owner)}/direct-status`;
    for (let index = 0; index < 2; index++) {
      const response = await operator.request(directPath);
      expect(response.status).toBe(200);
      expect(
        await decodeApplicationResponse(response, BlockOutcomeSchema),
      ).toMatchObject({
        kind: "block_status",
        status: { blocked: false, revision: 0, canSend: true },
      });
    }
    expect(await counts()).toEqual({ candidates: 0, writes: 0 });
    const list = await decodeApplicationResponse(
      await operator.request("/api/account/blocks"),
      BlockListSchema,
    );
    expect(list).toMatchObject({
      kind: "blocks",
      blocks: [],
      partial: false,
      unavailableTargetIds: [],
    });
    expect((await h.anonymous.request(personPath)).status).toBe(401);
    expect(
      (await operator.request(`/api/account/blocks/${userId}`)).status,
    ).toBe(400);
    expect(
      (await operator.request(`/api/account/blocks/${crypto.randomUUID()}`))
        .status,
    ).toBe(404);
    expect((await alice.request(directPath)).status).toBe(403);
    expect(await counts()).toEqual({ candidates: 0, writes: 0 });

    await env.IDENTITY_DB.prepare(
      "UPDATE identity_user SET emailVerified = 0 WHERE id = ?",
    )
      .bind(bob.profile!.userId)
      .run();
    expect(
      (await operator.request(`/api/account/blocks/${bob.profile!.userId}`))
        .status,
    ).toBe(404);
    expect((await operator.request(directPath)).status).toBe(401);
    expect(await counts()).toEqual({ candidates: 0, writes: 0 });
    await env.IDENTITY_DB.prepare(
      "UPDATE identity_user SET emailVerified = 1 WHERE id = ?",
    )
      .bind(bob.profile!.userId)
      .run();

    for (const [targetId, path] of [
      [alice.profile!.userId, personPath],
      [bob.profile!.userId, directPath],
    ]) {
      await operator.request(
        `/api/account/blocks/${targetId}`,
        blockCommand(),
        { method: "PUT" },
      );
      for (let index = 0; index < 2; index++) {
        expect(
          await decodeApplicationResponse(
            await operator.request(path!),
            BlockOutcomeSchema,
          ),
        ).toMatchObject({ kind: "block_status", status: { blocked: true } });
      }
    }
    expect(await counts()).toEqual({ candidates: 2, writes: 2 });
    for (let index = 0; index < 2; index++) {
      expect(
        await decodeApplicationResponse(
          await operator.request("/api/account/blocks/resolve", {
            targetIds: [alice.profile!.userId, bob.profile!.userId],
          }),
          BlockStatusesSchema,
        ),
      ).toMatchObject({
        kind: "block_statuses",
        statuses: [{ blocked: true }, { blocked: true }],
      });
    }
    expect(await counts()).toEqual({ candidates: 2, writes: 2 });
    const principal = await getPrincipal(
      new Request(env.AUTH_ORIGIN, {
        headers: { Cookie: operator.cookie },
      }),
      env,
    );
    if (!principal) throw new Error("Missing fixture principal");
    await env.IDENTITY_DB.prepare("DELETE FROM identity_session WHERE id = ?")
      .bind(principal.sessionId)
      .run();
    expect(await getBlock(env, principal, alice.profile!.userId)).toEqual({
      kind: "not_found",
    });
    expect(await counts()).toEqual({ candidates: 2, writes: 2 });
  });

  it.each(["person", "direct", "resolve"] as const)(
    "rejects positive %s status when identity or target verification changes after owner lookup",
    async (route) => {
      const h = applicationHarness();
      const operator = await h.bootstrap();
      const server = await h.createServer(operator);
      const { member } = await h.registerMember(operator, server.owner.id);
      const targetId = member.profile!.userId;
      const personPath = `/api/account/blocks/${targetId}`;
      await operator.request(personPath, blockCommand(), { method: "PUT" });
      const conversation = await decodeApplicationResponse(
        await operator.request("/api/conversations", { userId: targetId }),
        ResourceCreatedSchema,
      );
      if (conversation.kind !== "created") throw new Error(conversation.kind);
      const path =
        route === "person"
          ? personPath
          : route === "direct"
            ? `${resourcePath(conversation.owner)}/direct-status`
            : "/api/account/blocks/resolve";
      const body = route === "resolve" ? { targetIds: [targetId] } : undefined;
      let revokeSession = false;
      const afterRead = async (result: BlockOutcome, principal: Principal) => {
        expect(result).toMatchObject({
          kind: "block_status",
          status: { blocked: true },
        });
        await (
          revokeSession
            ? env.IDENTITY_DB.prepare(
                "DELETE FROM identity_session WHERE id = ?",
              ).bind(principal.sessionId)
            : env.IDENTITY_DB.prepare(
                "UPDATE identity_user SET emailVerified = 0 WHERE id = ?",
              ).bind(targetId)
        ).run();
        return result;
      };
      const native = env.CONVERSATION_DO.getByName.bind(env.CONVERSATION_DO);
      const lookup = vi
        .spyOn(env.CONVERSATION_DO, "getByName")
        .mockImplementation((name, options) => {
          const stub = native(name, options);
          return new Proxy(stub, {
            get(target, property) {
              if (property === "blockStatus")
                return async (principal: Principal, targetId: string) =>
                  afterRead(
                    await target.blockStatus(principal, targetId),
                    principal,
                  );
              if (property === "directStatus")
                return async (principal: Principal) =>
                  afterRead(await target.directStatus(principal), principal);
              return Reflect.get(target, property, target);
            },
          });
        });
      try {
        expect((await operator.request(path, body)).status).toBe(401);
        await env.IDENTITY_DB.prepare(
          "UPDATE identity_user SET emailVerified = 1 WHERE id = ?",
        )
          .bind(targetId)
          .run();
        revokeSession = true;
        expect((await operator.request(path, body)).status).toBe(401);
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it("keeps blocking before first DM private, broadcasts policy invalidation and preserves history/downloads", async () => {
    const h = attachmentHarness();
    const alice = await h.bootstrap();
    const server = await h.createServer(alice);
    const { member: bob } = await h.registerMember(
      alice,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const target = bob.profile!.userId;
    const path = `/api/account/blocks/${target}`;
    expect((await h.anonymous.request("/api/account/blocks")).status).toBe(401);
    expect(
      (
        await alice.request(path, blockCommand(), {
          method: "PUT",
          origin: "https://other.invalid",
        })
      ).status,
    ).toBe(403);
    const blocked = await alice.request(path, blockCommand(), {
      method: "PUT",
    });
    expect(blocked.status).toBe(200);
    expect(
      await decodeApplicationResponse(blocked, BlockOutcomeSchema),
    ).toMatchObject({
      kind: "block_updated",
      status: { blocked: true, revision: 1, canSend: false },
    });
    const navigation = await decodeApplicationResponse(
      await bob.request("/api/directory"),
      ResourceDirectorySchema,
    );
    if (navigation.kind !== "directory") throw new Error(navigation.kind);
    expect(navigation.resources.map((resource) => resource.owner.kind)).toEqual(
      ["server"],
    );
    const created = await decodeApplicationResponse(
      await alice.request("/api/conversations", { userId: target }),
      ResourceCreatedSchema,
    );
    if (created.kind !== "created") throw new Error(created.kind);
    const dmPath = resourcePath(created.owner);
    expect(
      await decodeApplicationResponse(
        await bob.request(`${dmPath}/direct-status`),
        BlockOutcomeSchema,
      ),
    ).toMatchObject({
      kind: "block_status",
      status: {
        targetId: alice.profile!.userId,
        blocked: false,
        revision: 0,
        canSend: false,
      },
    });
    expect(
      await readHttpFailure(
        await bob.request(`${dmPath}/send`, messageCommand(created.channelId)),
      ),
    ).toMatchObject({ code: "DM_BLOCKED" });
    expect(
      await decodeApplicationResponse(
        await alice.request(path, blockCommand(false, 1), { method: "PUT" }),
        BlockOutcomeSchema,
      ),
    ).toMatchObject({
      kind: "block_updated",
      status: { blocked: false, revision: 2 },
    });
    const file = await h.reserve(
      alice,
      dmPath,
      created.channelId,
      "retained.txt",
      3,
    );
    await attachmentResult(
      await h.put(alice, `${file.path}/content`, new Uint8Array([1, 2, 3])),
    );
    const command = {
      ...messageCommand(created.channelId, "東京都 retained message"),
      attachmentIds: [file.fileId],
    };
    const receipt = await messagingResult(
      await alice.request(`${dmPath}/send`, command),
    );
    if (receipt.kind !== "accepted") throw new Error(receipt.kind);
    const first = await h.socket(alice, dmPath, created.channelId);
    const second = await h.socket(bob, dmPath, created.channelId);
    try {
      await decodeApplicationResponse(
        await alice.request(path, blockCommand(true, 2), { method: "PUT" }),
        BlockOutcomeSchema,
      );
      expect(await first.next()).toEqual({ type: "dm_policy_changed" });
      expect(await second.next()).toEqual({ type: "dm_policy_changed" });
      expect(
        await messagingResult(await alice.request(`${dmPath}/send`, command)),
      ).toEqual(receipt);
      // The exact retry still publishes its committed receipt through the same valid wire contract.
      expect((await first.next()).type).toBe("committed");
      expect((await second.next()).type).toBe("committed");
      expect(
        await messagingResult(
          await bob.request(`${dmPath}/snapshot`, {
            channelId: created.channelId,
          }),
        ),
      ).toMatchObject({
        kind: "snapshot",
        messages: [
          {
            id: receipt.receipt.messageId,
            attachments: [{ fileId: file.fileId }],
          },
        ],
      });
      expect(
        await messagingResult(
          await bob.request(`${dmPath}/search`, {
            channelId: created.channelId,
            query: "東京都",
          }),
        ),
      ).toMatchObject({
        kind: "matches",
        messages: [{ id: receipt.receipt.messageId }],
      });
      const download = await h.download(bob, `${dmPath}/files/${file.fileId}`);
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(
        await readHttpFailure(
          await bob.request(
            `${dmPath}/send`,
            messageCommand(created.channelId),
          ),
        ),
      ).toMatchObject({ code: "DM_BLOCKED" });
      expect(
        await readHttpFailure(
          await alice.request(`${dmPath}/files/reserve`, {
            ...file.command,
            commandId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ code: "DM_BLOCKED" });
      const notices = await decodeApplicationResponse(
        await alice.request("/api/account/blocks/resolve", {
          targetIds: [target],
        }),
        BlockStatusesSchema,
      );
      expect(notices).toMatchObject({
        kind: "block_statuses",
        statuses: [{ targetId: target, blocked: true }],
        partial: false,
        unavailableTargetIds: [],
      });
      const reverse = await decodeApplicationResponse(
        await bob.request("/api/account/blocks/resolve", {
          targetIds: [alice.profile!.userId],
        }),
        BlockStatusesSchema,
      );
      expect(reverse).toMatchObject({
        kind: "block_statuses",
        statuses: [{ blocked: false, revision: 0, canSend: false }],
      });
      expect(
        await messagingResult(
          await bob.request(
            `${server.path}/send`,
            messageCommand(server.channelId),
          ),
        ),
      ).toMatchObject({ kind: "accepted" });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("retains a candidate when the actor fails and discovers an acknowledged retry from another device", async () => {
    const h = applicationHarness();
    const alice = await h.bootstrap();
    const server = await h.createServer(alice);
    const { member: bob } = await h.registerMember(
      alice,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const target = bob.profile!.userId;
    const id = await directConversationId(alice.profile!.userId, target);
    const owner = env.CONVERSATION_DO.getByName(id);
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER unavailable_actor AFTER INSERT ON block_receipts BEGIN SELECT RAISE(ABORT, 'injected actor failure after candidate'); END",
      );
    });
    const command = blockCommand();
    const path = `/api/account/blocks/${target}`;
    expect((await alice.request(path, command, { method: "PUT" })).status).toBe(
      500,
    );
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT user_id, target_id, conversation_id FROM block_candidates WHERE user_id = ?",
      )
        .bind(alice.profile!.userId)
        .all(),
    ).toMatchObject({
      results: [
        {
          user_id: alice.profile!.userId,
          target_id: target,
          conversation_id: id,
        },
      ],
    });
    expect(
      await decodeApplicationResponse(
        await alice.request("/api/account/blocks"),
        BlockListSchema,
      ),
    ).toEqual({
      kind: "blocks",
      blocks: [],
      partial: false,
      unavailableTargetIds: [],
      nextCursor: null,
    });
    await runInDurableObject(owner, (_instance, state) =>
      state.storage.sql.exec("DROP TRIGGER unavailable_actor"),
    );
    expect(
      await decodeApplicationResponse(
        await alice.request(path, command, { method: "PUT" }),
        BlockOutcomeSchema,
      ),
    ).toMatchObject({
      kind: "block_updated",
      status: { blocked: true, revision: 1 },
    });
    const otherDevice = await h.signIn(h.client(), "operator@example.invalid");
    expect(otherDevice.bookmark).toBeUndefined();
    const sessions = vi.spyOn(env.IDENTITY_DB, "withSession");
    try {
      expect(
        await decodeApplicationResponse(
          await otherDevice.request("/api/account/blocks"),
          BlockListSchema,
        ),
      ).toMatchObject({
        kind: "blocks",
        blocks: [{ targetId: target, blocked: true, revision: 1 }],
        partial: false,
      });
      expect(sessions).toHaveBeenCalledWith("first-primary");
    } finally {
      sessions.mockRestore();
    }
    expect(
      await decodeApplicationResponse(
        await bob.request("/api/account/blocks"),
        BlockListSchema,
      ),
    ).toMatchObject({ kind: "blocks", blocks: [] });
    await alice.request(path, blockCommand(false, 1), { method: "PUT" });
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM block_candidates WHERE user_id = ?",
      )
        .bind(alice.profile!.userId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await decodeApplicationResponse(
        await alice.request("/api/account/blocks"),
        BlockListSchema,
      ),
    ).toMatchObject({ kind: "blocks", blocks: [] });
  });

  it("pages candidate references and reports an unavailable owner without calling it unblocked", async () => {
    const h = applicationHarness();
    const alice = await h.bootstrap();
    const userId = alice.profile!.userId;
    const targets = Array.from(
      { length: 33 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    );
    const ids = await Promise.all(
      targets.map((target) => directConversationId(userId, target)),
    );
    await env.IDENTITY_DB.batch(
      targets.flatMap((target, index) => [
        env.IDENTITY_DB.prepare(
          "INSERT INTO identity_user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
        ).bind(
          target,
          `Person ${index}`,
          `person-${index}@example.invalid`,
          new Date().toISOString(),
          new Date().toISOString(),
        ),
        env.IDENTITY_DB.prepare(
          "INSERT INTO block_candidates(user_id, target_id, conversation_id) VALUES (?, ?, ?)",
        ).bind(userId, target, ids[index]!),
      ]),
    );
    for (const index of [0, 32])
      expect(
        (
          await alice.request(
            `/api/account/blocks/${targets[index]}`,
            blockCommand(),
            { method: "PUT" },
          )
        ).status,
      ).toBe(200);
    const failed = env.CONVERSATION_DO.getByName(ids[1]!);
    await runInDurableObject(failed, (_instance, state) =>
      state.storage.sql.exec("DROP TABLE direct_blocks"),
    );
    const first = await decodeApplicationResponse(
      await alice.request("/api/account/blocks"),
      BlockListSchema,
    );
    if (first.kind !== "blocks") throw new Error(first.kind);
    expect(first).toMatchObject({
      blocks: [{ targetId: targets[0], blocked: true }],
      partial: true,
      unavailableTargetIds: [targets[1]],
      nextCursor: targets[31],
    });
    const second = await decodeApplicationResponse(
      await alice.request(`/api/account/blocks?after=${first.nextCursor}`),
      BlockListSchema,
    );
    expect(second).toMatchObject({
      blocks: [{ targetId: targets[32], blocked: true }],
      partial: false,
      unavailableTargetIds: [],
      nextCursor: null,
    });
    expect(
      await decodeApplicationResponse(
        await alice.request("/api/account/blocks/resolve", {
          targetIds: targets.slice(0, 3),
        }),
        BlockStatusesSchema,
      ),
    ).toMatchObject({
      kind: "block_statuses",
      statuses: [
        { targetId: targets[0], blocked: true },
        { targetId: targets[2], blocked: false },
      ],
      partial: true,
      unavailableTargetIds: [targets[1]],
    });
    expect(
      (
        await alice.request("/api/account/blocks/resolve", {
          targetIds: targets.slice(0, 17),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await alice.request("/api/account/blocks/resolve", {
          targetIds: [targets[0], targets[0]],
        })
      ).status,
    ).toBe(400);
  });
});
