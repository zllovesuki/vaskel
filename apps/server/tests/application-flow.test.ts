import { readHttpFailure } from "@tests/helpers/http";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SignOutResponseSchema } from "@vaskel/contracts/identity";
import {
  GrantResponseSchema,
  InviteRegistrationResponseSchema,
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import {
  MessagingOutcomeSchema,
  SOCKET_LEASE_MS,
  SOCKET_TICKET_MS,
} from "@vaskel/contracts/messaging";
import { privateFingerprint } from "@/server/auth/crypto";
import { DIRECTORY_SYNC_AT } from "@/server/actors/shared/directory-sync";
import {
  applicationHarness,
  applicationSocket,
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
} from "@tests/helpers/application-harness";

describe("integrated authenticated HTTP, D1 directory and message actors", () => {
  it("registers by invitation with stable retries and isolates two server memberships despite forged navigation metadata", async () => {
    const h = applicationHarness();
    const { operator, first, second, alice, bob } = await h.twoServers();
    expect(
      await decodeApplicationResponse(
        await h.anonymous.request("/api/invites/register", alice.registration),
        InviteRegistrationResponseSchema,
      ),
    ).toEqual(alice.registered);
    expect(alice.registered.userId).toBe(alice.member.profile?.userId);
    expect(bob.registered.userId).toBe(bob.member.profile?.userId);
    expect(alice.member.profile?.isOperator).toBe(false);
    expect(bob.member.profile?.isOperator).toBe(false);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_user",
      ).first("count"),
    ).toBe(3);
    const changed = await readHttpFailure(
      await h.anonymous.request("/api/invites/register", {
        ...alice.registration,
        displayName: "Changed command",
      }),
    );
    expect(changed).toMatchObject({ code: "AUTHORIZATION_CONFLICT" });

    const aliceDirectoryResponse = await alice.member.request("/api/directory");
    const aliceDirectory = await decodeApplicationResponse(
      aliceDirectoryResponse,
      ResourceDirectorySchema,
    );
    const bobDirectory = await decodeApplicationResponse(
      await bob.member.request("/api/directory"),
      ResourceDirectorySchema,
    );
    expect(aliceDirectory.kind).toBe("directory");
    expect(bobDirectory.kind).toBe("directory");
    if (
      aliceDirectory.kind !== "directory" ||
      bobDirectory.kind !== "directory"
    )
      throw new Error("Integrated directory failed.");
    expect(
      aliceDirectory.resources.map((resource) => resource.owner.id),
    ).toEqual([first.owner.id]);
    expect(bobDirectory.resources.map((resource) => resource.owner.id)).toEqual(
      [second.owner.id],
    );
    expect(aliceDirectory.canCreateServers).toBe(false);
    expect(
      aliceDirectoryResponse.headers.get("X-Vaskel-D1-Bookmark"),
    ).not.toBeNull();
    expect(alice.member.bookmark).toBe(
      aliceDirectoryResponse.headers.get("X-Vaskel-D1-Bookmark"),
    );
    const aliceBookmark = alice.member.bookmark;
    const bobBookmark = bob.member.bookmark;
    if (!aliceBookmark || !bobBookmark)
      throw new Error("Integrated directory did not emit bookmarks.");

    const firstSnapshot = await decodeApplicationResponse(
      await operator.request(`${first.path}/snapshot`, {
        channelId: first.channelId,
      }),
      MessagingOutcomeSchema,
    );
    const secondSnapshot = await decodeApplicationResponse(
      await operator.request(`${second.path}/snapshot`, {
        channelId: second.channelId,
      }),
      MessagingOutcomeSchema,
    );
    if (firstSnapshot.kind !== "snapshot" || secondSnapshot.kind !== "snapshot")
      throw new Error("Integrated snapshot failed.");
    for (const [client, other, cursor] of [
      [alice.member, second, secondSnapshot.cursor],
      [bob.member, first, firstSnapshot.cursor],
    ] as const) {
      expect(
        await readHttpFailure(await client.request(other.path)),
      ).toMatchObject({ code: "FORBIDDEN" });
      for (const [operation, body] of [
        ["snapshot", { channelId: other.channelId }],
        ["search", { channelId: other.channelId, query: "東京都" }],
        ["replay", { channelId: other.channelId, cursor }],
      ] as const) {
        const response = await client.request(
          `${other.path}/${operation}`,
          body,
        );
        expect(response.status).toBe(403);
        expect(await readHttpFailure(response)).toMatchObject({
          code: "FORBIDDEN",
        });
      }
    }

    await h.environment.IDENTITY_DB.prepare(
      "INSERT INTO resource_membership_index(resource_id,user_id) VALUES(?,?)",
    )
      .bind(second.owner.id, alice.registered.userId)
      .run();
    const forged = await decodeApplicationResponse(
      await alice.member.request("/api/directory", undefined, {
        bookmark: bobBookmark,
      }),
      ResourceDirectorySchema,
    );
    if (forged.kind !== "directory")
      throw new Error("Integrated forged directory failed.");
    expect(forged.resources.map((resource) => resource.owner.id)).toEqual([
      first.owner.id,
    ]);
    const anonymous = await h.anonymous.request(first.path, undefined, {
      bookmark: aliceBookmark,
      headers: {
        "X-Vaskel-User-Id": alice.registered.userId,
        "X-Vaskel-Session-Id": "attacker-selected-session",
      },
    });
    expect(anonymous.status).toBe(401);
    expect(await readHttpFailure(anonymous)).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const deniedCreation = await alice.member.request("/api/servers", {
      commandId: crypto.randomUUID(),
      name: "Unauthorized server",
    });
    expect(deniedCreation.status).toBe(403);
    expect(await readHttpFailure(deniedCreation)).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_directory",
      ).first("count"),
    ).toBe(2);
    const selfGrant = await alice.member.request(
      "/api/operator/server-creation",
      { userId: alice.registered.userId, allowed: true },
    );
    expect(selfGrant.status).toBe(403);
    expect(await readHttpFailure(selfGrant)).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await decodeApplicationResponse(
        await operator.request("/api/operator/server-creation", {
          userId: alice.registered.userId,
          allowed: true,
        }),
        GrantResponseSchema,
      ),
    ).toEqual({ kind: "granted" });
    const delegated = await h.createServer(alice.member, "Delegated server");
    expect(
      (
        await decodeApplicationResponse(
          await alice.member.request(delegated.path),
          DirectoryOutcomeSchema,
        )
      ).kind,
    ).toBe("directory");
    expect(
      await decodeApplicationResponse(
        await operator.request("/api/operator/server-creation", {
          userId: alice.registered.userId,
          allowed: false,
        }),
        GrantResponseSchema,
      ),
    ).toEqual({ kind: "granted" });
    expect(
      await readHttpFailure(
        await alice.member.request("/api/servers", {
          commandId: crypto.randomUUID(),
          name: "Revoked creation",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_directory",
      ).first("count"),
    ).toBe(3);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM directory_audit WHERE target_id = ?",
      )
        .bind(alice.registered.userId)
        .first("count"),
    ).toBe(2);
  });

  it("creates one canonical DM from either participant and exposes retries, stale edits, search and deletion tombstones through the shared HTTP contract", async () => {
    const h = applicationHarness();
    const { operator, alice, bob } = await h.twoServers();
    const created = await decodeApplicationResponse(
      await alice.member.request("/api/conversations", {
        userId: bob.registered.userId,
      }),
      ResourceCreatedSchema,
    );
    const reverse = await decodeApplicationResponse(
      await bob.member.request("/api/conversations", {
        userId: alice.registered.userId,
      }),
      ResourceCreatedSchema,
    );
    if (created.kind !== "created" || reverse.kind !== "created")
      throw new Error("Integrated DM factory failed.");
    expect(reverse).toEqual(created);
    const path = resourcePath(created.owner);
    const initial = await decodeApplicationResponse(
      await alice.member.request(`${path}/snapshot`, {
        channelId: created.channelId,
      }),
      MessagingOutcomeSchema,
    );
    if (initial.kind !== "snapshot")
      throw new Error("Integrated DM snapshot failed.");
    const command = messageCommand(
      created.channelId,
      "今日は東京都で会話。数据库设计 𠮷",
    );
    const sent = await decodeApplicationResponse(
      await alice.member.request(`${path}/send`, command),
      MessagingOutcomeSchema,
    );
    const retry = await decodeApplicationResponse(
      await alice.member.request(`${path}/send`, command),
      MessagingOutcomeSchema,
    );
    if (sent.kind !== "accepted") throw new Error("Integrated DM send failed.");
    expect(retry).toEqual(sent);
    expect(sent.receipt.sequence).toBe(1);
    const conflict = await alice.member.request(`${path}/send`, {
      ...command,
      body: "Changed command body",
    });
    expect(conflict.status).toBe(409);
    expect(await readHttpFailure(conflict)).toMatchObject({
      code: "COMMAND_CONFLICT",
    });
    const found = await decodeApplicationResponse(
      await bob.member.request(`${path}/search`, {
        channelId: created.channelId,
        query: "数据库",
      }),
      MessagingOutcomeSchema,
    );
    if (found.kind !== "matches")
      throw new Error("Integrated CJK search failed.");
    expect(found.messages.map((message) => message.id)).toEqual([
      sent.receipt.messageId,
    ]);
    const attemptedEdit = await bob.member.request(`${path}/edit`, {
      ...messageCommand(created.channelId),
      messageId: sent.receipt.messageId,
      expectedVersion: 1,
    });
    expect(attemptedEdit.status).toBe(403);
    expect(await readHttpFailure(attemptedEdit)).toMatchObject({
      code: "FORBIDDEN",
    });
    const edited = await decodeApplicationResponse(
      await alice.member.request(`${path}/edit`, {
        ...messageCommand(created.channelId, "東京都の新しい会話"),
        messageId: sent.receipt.messageId,
        expectedVersion: 1,
      }),
      MessagingOutcomeSchema,
    );
    if (edited.kind !== "accepted")
      throw new Error("Integrated DM edit failed.");
    expect(edited.receipt.version).toBe(2);
    const stale = await alice.member.request(`${path}/edit`, {
      ...messageCommand(created.channelId),
      messageId: sent.receipt.messageId,
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await readHttpFailure(stale)).toMatchObject({
      code: "STALE_VERSION",
      data: { kind: "stale_version", currentVersion: 2 },
    });
    const deleted = await decodeApplicationResponse(
      await alice.member.request(`${path}/delete`, {
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
        channelId: created.channelId,
        messageId: sent.receipt.messageId,
        expectedVersion: 2,
      }),
      MessagingOutcomeSchema,
    );
    if (deleted.kind !== "accepted")
      throw new Error("Integrated DM deletion failed.");
    expect(deleted.receipt).toMatchObject({ sequence: 3, version: 3 });
    const snapshot = await decodeApplicationResponse(
      await bob.member.request(`${path}/snapshot`, {
        channelId: created.channelId,
      }),
      MessagingOutcomeSchema,
    );
    if (snapshot.kind !== "snapshot")
      throw new Error("Integrated tombstone snapshot failed.");
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      id: sent.receipt.messageId,
      body: null,
      version: 3,
    });
    expect(snapshot.messages[0]?.deletedAt).not.toBeNull();
    const replay = await decodeApplicationResponse(
      await bob.member.request(`${path}/replay`, {
        channelId: created.channelId,
        cursor: initial.cursor,
      }),
      MessagingOutcomeSchema,
    );
    if (replay.kind !== "replay") throw new Error("Integrated replay failed.");
    expect(replay.events.map((event) => event.operation)).toEqual([
      "send",
      "edit",
      "delete",
    ]);
    expect(replay.events.every((event) => event.message.body === null)).toBe(
      true,
    );
    expect(replay.cursor.sequence).toBe(3);
    expect(
      await decodeApplicationResponse(
        await bob.member.request(`${path}/search`, {
          channelId: created.channelId,
          query: "東京都",
        }),
        MessagingOutcomeSchema,
      ),
    ).toEqual({ kind: "matches", messages: [] });
    expect(
      await decodeApplicationResponse(
        await alice.member.request(`${path}/send`, command),
        MessagingOutcomeSchema,
      ),
    ).toEqual(sent);
    const operatorAccess = await operator.request(`${path}/snapshot`, {
      channelId: created.channelId,
    });
    expect(operatorAccess.status).toBe(403);
    expect(await readHttpFailure(operatorAccess)).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_directory WHERE kind = 'conversation'",
      ).first("count"),
    ).toBe(1);
  });

  it("keeps failed resource publication pending and retries initialization without duplicating the actor", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const command = {
      commandId: crypto.randomUUID(),
      name: "Publication retry",
    };
    await h.environment.IDENTITY_DB.prepare(
      "CREATE TRIGGER fail_directory_publication BEFORE UPDATE OF lifecycle ON resource_directory WHEN NEW.lifecycle = 'ready' BEGIN SELECT RAISE(ABORT, 'fixture_publication_failure'); END",
    ).run();
    const failed = await operator.request("/api/servers", command);
    expect(failed.status).toBe(500);
    expect((await readHttpFailure(failed)).code).toBe("INTERNAL_SERVER_ERROR");
    const pending = await h.environment.IDENTITY_DB.prepare(
      "SELECT id,lifecycle FROM resource_directory WHERE name = ?",
    )
      .bind(command.name)
      .first<{ id: string; lifecycle: string }>();
    expect(pending?.lifecycle).toBe("pending");
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_membership_index",
      ).first("count"),
    ).toBe(0);
    if (!pending) throw new Error("Integrated pending reservation missing.");
    expect(
      await readHttpFailure(
        await operator.request(`/api/resources/server/${pending.id}`),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    const beforeRetry = await decodeApplicationResponse(
      await operator.request("/api/directory"),
      ResourceDirectorySchema,
    );
    if (beforeRetry.kind !== "directory")
      throw new Error("Integrated pending directory failed.");
    expect(beforeRetry.resources).toEqual([]);
    await h.environment.IDENTITY_DB.prepare(
      "DROP TRIGGER fail_directory_publication",
    ).run();
    const recovered = await decodeApplicationResponse(
      await operator.request("/api/servers", command),
      ResourceCreatedSchema,
    );
    if (recovered.kind !== "created")
      throw new Error("Integrated resource recovery failed.");
    expect(recovered.owner.id).toBe(pending.id);
    expect(
      await decodeApplicationResponse(
        await operator.request("/api/servers", command),
        ResourceCreatedSchema,
      ),
    ).toEqual(recovered);
    const changed = await operator.request("/api/servers", {
      ...command,
      name: "Changed command payload",
    });
    expect(changed.status).toBe(409);
    expect(await readHttpFailure(changed)).toMatchObject({
      code: "COMMAND_CONFLICT",
    });
    const directory = await decodeApplicationResponse(
      await operator.request("/api/directory"),
      ResourceDirectorySchema,
    );
    if (directory.kind !== "directory")
      throw new Error("Integrated recovered directory failed.");
    expect(directory.resources.map((resource) => resource.owner.id)).toEqual([
      pending.id,
    ]);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_directory",
      ).first("count"),
    ).toBe(1);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_membership_index",
      ).first("count"),
    ).toBe(1);
  });

  it("authorizes direct reads independently of a missing navigation index and retains bookmark chaining", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member, registered } = await h.registerMember(
      operator,
      server.owner.id,
    );
    // Finish join reconciliation before removing its published index row.
    await expect
      .poll(() =>
        runInDurableObject(
          h.environment.SERVER_DO.getByName(server.owner.id),
          (_instance, state) => state.storage.get(DIRECTORY_SYNC_AT),
        ),
      )
      .toBeUndefined();
    await h.environment.IDENTITY_DB.prepare(
      "DELETE FROM resource_membership_index WHERE resource_id = ? AND user_id = ?",
    )
      .bind(server.owner.id, registered.userId)
      .run();
    const missing = await decodeApplicationResponse(
      await member.request("/api/directory"),
      ResourceDirectorySchema,
    );
    if (missing.kind !== "directory")
      throw new Error("Integrated missing projection directory failed.");
    expect(missing.resources).toEqual([]);
    const directResponse = await member.request(server.path);
    const direct = await decodeApplicationResponse(
      directResponse,
      DirectoryOutcomeSchema,
    );
    expect(direct.kind).toBe("directory");
    expect(directResponse.headers.get("X-Vaskel-D1-Bookmark")).not.toBeNull();
    const directoryResponse = await member.request("/api/directory");
    const directory = await decodeApplicationResponse(
      directoryResponse,
      ResourceDirectorySchema,
    );
    if (directory.kind !== "directory")
      throw new Error("Integrated directory failed.");
    expect(directory.resources).toEqual([]);
    expect(member.bookmark).toBe(
      directoryResponse.headers.get("X-Vaskel-D1-Bookmark"),
    );
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_membership_index WHERE resource_id = ? AND user_id = ?",
      )
        .bind(server.owner.id, registered.userId)
        .first("count"),
    ).toBe(0);
  });

  it("upgrades through HTTP with session-bound single-use tickets and fences new requests after logout within the existing socket lease", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member } = await h.registerMember(operator, server.owner.id);
    const anotherOperatorSession = await h.signIn(
      h.client(),
      "operator@example.invalid",
    );
    const preparedAt = Date.now();
    const prepared = await decodeApplicationResponse(
      await operator.request(`${server.path}/socket-ticket`, {
        channelId: server.channelId,
      }),
      MessagingOutcomeSchema,
    );
    if (prepared.kind !== "socket_ticket")
      throw new Error("Integrated socket ticket failed.");
    const headers = {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${prepared.ticket}`,
    };
    for (const wrong of [member, anotherOperatorSession]) {
      const rejected = await wrong.request(`${server.path}/socket`, undefined, {
        headers: {
          ...headers,
          "X-Vaskel-User-Id": operator.profile?.userId ?? "forged-user",
          "X-Vaskel-Session-Id": "forged-session",
        },
      });
      expect(rejected.status).toBe(403);
      await rejected.text();
    }
    const stub = h.environment.SERVER_DO.getByName(server.owner.id);
    await runInDurableObject(stub, (_instance, state) =>
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM socket_tickets")
          .one(),
      ).toEqual({ count: 1 }),
    );
    const upgraded = await operator.request(
      `${server.path}/socket`,
      undefined,
      { headers },
    );
    expect(upgraded.headers.get("Sec-WebSocket-Protocol")).toBe("vaskel-v1");
    const stream = await applicationSocket(upgraded);
    try {
      expect(stream.ready.leaseExpiresAt).toBe(prepared.leaseExpiresAt);
      expect(prepared.leaseExpiresAt - prepared.expiresAt).toBeLessThanOrEqual(
        SOCKET_LEASE_MS - SOCKET_TICKET_MS,
      );
      expect(stream.ready.leaseExpiresAt - preparedAt).toBeLessThanOrEqual(
        SOCKET_LEASE_MS + 1_000,
      );
      expect(stream.ready.cursor.owner).toEqual(server.owner);
      expect(
        (
          await operator.request(`${server.path}/socket`, undefined, {
            headers,
          })
        ).status,
      ).toBe(403);
      const committed = stream.next();
      const sent = await decodeApplicationResponse(
        await member.request(
          `${server.path}/send`,
          messageCommand(server.channelId),
        ),
        MessagingOutcomeSchema,
      );
      if (sent.kind !== "accepted")
        throw new Error("Integrated socket send failed.");
      const frame = await committed;
      expect(frame.type).toBe("committed");
      if (frame.type === "committed")
        expect(frame.event.message.id).toBe(sent.receipt.messageId);
      expect(
        await decodeApplicationResponse(
          await operator.request("/api/identity/sign-out", {}),
          SignOutResponseSchema,
        ),
      ).toEqual({ status: "signed_out" });
      for (const [operation, body] of [
        ["socket-ticket", { channelId: server.channelId }],
        ["send", messageCommand(server.channelId)],
      ] as const) {
        const rejected = await operator.request(
          `${server.path}/${operation}`,
          body,
        );
        expect(rejected.status).toBe(401);
        expect(await readHttpFailure(rejected)).toMatchObject({
          code: "UNAUTHENTICATED",
        });
      }
      const leased = stream.next();
      stream.client.send('{"type":"reconcile"}');
      expect((await leased).type).toBe("reconcile");
      await runInDurableObject(stub, (_instance, state) => {
        for (const websocket of state.getWebSockets()) {
          const attachment: unknown = websocket.deserializeAttachment();
          if (attachment === null || typeof attachment !== "object")
            throw new Error("Invalid integrated socket attachment.");
          websocket.serializeAttachment({ ...attachment, leaseExpiresAt: 0 });
        }
      });
      const expired = stream.next();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await expired).toEqual({ type: "lease_expired" });
      expect(
        (
          await member.request(`${server.path}/snapshot`, {
            channelId: server.channelId,
          })
        ).status,
      ).toBe(200);
    } finally {
      await stream.close();
    }
  });

  it("admits sockets without directory materialization and preserves current owner and channel refusals", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member } = await h.registerMember(operator, server.owner.id);
    const stub = h.environment.SERVER_DO.getByName(server.owner.id);
    const headersFor = async (client: typeof operator) => {
      const prepared = await decodeApplicationResponse(
        await client.request(`${server.path}/socket-ticket`, {
          channelId: server.channelId,
        }),
        MessagingOutcomeSchema,
      );
      if (prepared.kind !== "socket_ticket") throw new Error(prepared.kind);
      return {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${prepared.ticket}`,
        "X-Vaskel-Assertion-Expires-At": "0",
      };
    };
    const operatorHeaders = await headersFor(operator);
    const memberHeaders = await headersFor(member);
    await runInDurableObject(stub, (_, state) => {
      // Directory materialization reads occupancy; admission needs only current access.
      state.storage.sql.exec("DROP TABLE channel_occupancy");
    });
    const stream = await applicationSocket(
      await operator.request(`${server.path}/socket`, undefined, {
        headers: operatorHeaders,
      }),
    );
    await stream.close();
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "UPDATE channels SET private = 1 WHERE id = ?",
        server.channelId,
      );
    });
    const privateRefusal = await member.request(
      `${server.path}/socket`,
      undefined,
      { headers: memberHeaders },
    );
    expect(privateRefusal.status).toBe(403);
    expect(await readHttpFailure(privateRefusal)).toMatchObject({
      code: "FORBIDDEN",
    });
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        "UPDATE channels SET private = 0 WHERE id = ?",
        server.channelId,
      );
      state.storage.sql.exec(
        "DELETE FROM members WHERE user_id = ?",
        member.profile!.userId,
      );
    });
    const removed = await member.request(`${server.path}/socket`, undefined, {
      headers: memberHeaders,
    });
    expect(removed.status).toBe(403);
    expect(await readHttpFailure(removed)).toMatchObject({ code: "FORBIDDEN" });
    const missing = await operator.request(
      `/api/resources/server/${crypto.randomUUID()}/socket`,
      undefined,
      { headers: operatorHeaders },
    );
    expect(missing.status).toBe(404);
    expect(await readHttpFailure(missing)).toMatchObject({ code: "NOT_FOUND" });
    const freshHeaders = await headersFor(operator);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("DELETE FROM owner_state");
    });
    const uninitialized = await operator.request(
      `${server.path}/socket`,
      undefined,
      { headers: freshHeaders },
    );
    expect(uninitialized.status).toBe(404);
    expect(await readHttpFailure(uninitialized)).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("enforces HTTP origin, body and schema boundaries and returns 429 from the native rate binding", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const command = messageCommand(server.channelId);
    for (const origin of [null, "https://attacker.invalid"]) {
      const response = await operator.request(`${server.path}/send`, command, {
        origin,
      });
      expect(response.status).toBe(403);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "ORIGIN_REJECTED",
      });
    }
    for (const [body, options] of [
      [{ ...command, body: " " }, {}],
      [{ ...command, userId: operator.profile?.userId }, {}],
      [undefined, { rawBody: "{" }],
      [command, { headers: { "Content-Type": "text/plain" } }],
    ] as const) {
      const response = await operator.request(
        `${server.path}/send`,
        body,
        options,
      );
      expect(response.status).toBe(400);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    const tooLarge = await operator.request(`${server.path}/send`, undefined, {
      rawBody: "x".repeat(256 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(await readHttpFailure(tooLarge)).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    const invalidId = await operator.request(
      "/api/resources/server/invalid-id/snapshot",
      { channelId: server.channelId },
    );
    expect(invalidId.status).toBe(404);
    expect(await readHttpFailure(invalidId)).toMatchObject({
      code: "NOT_FOUND",
    });
    const key = await privateFingerprint(
      h.environment.AUTH_SECRET,
      `sign-in:${operator.address}`,
    );
    let exhausted = false;
    for (let index = 0; index < 100; index++) {
      if (!(await h.environment.AUTH_RATE_LIMITER.limit({ key })).success) {
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
    const limited = await operator.request("/api/identity/sign-in", {
      email: "operator@example.invalid",
      password: "correct horse battery staple",
    });
    expect(limited.status).toBe(429);
    expect(await readHttpFailure(limited)).toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(
      (
        await operator.request(`${server.path}/snapshot`, {
          channelId: server.channelId,
        })
      ).status,
    ).toBe(200);
  });
});
