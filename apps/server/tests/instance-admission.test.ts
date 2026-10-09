import { readHttpFailure } from "@tests/helpers/http";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapOperator,
  registerAuthorizedAccount,
} from "@/server/auth/accounts";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { createConversation, createServer } from "@/server/directory/resources";
import { applicationHarness } from "@tests/helpers/application-harness";
import { identityHarness, testPassword } from "@tests/helpers/identity-harness";

async function principal(operator = false): Promise<IdentityPrincipal> {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const email = `${userId}@example.invalid`;
  const now = new Date().toISOString();
  const expiresAt = Date.now() + 3_600_000;
  const statements = [
    env.IDENTITY_DB.prepare(
      "INSERT INTO identity_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    ).bind(userId, "Admission fixture", email, now, now),
    env.IDENTITY_DB.prepare(
      "INSERT INTO identity_session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
    ).bind(
      sessionId,
      userId,
      crypto.randomUUID(),
      new Date(expiresAt).toISOString(),
      now,
      now,
    ),
  ];
  if (operator)
    statements.push(
      env.IDENTITY_DB.prepare(
        "INSERT INTO identity_operator(singleton,user_id,operation_id,created_at) VALUES(1,?,?,?)",
      ).bind(userId, crypto.randomUUID(), Date.now()),
    );
  await env.IDENTITY_DB.batch(statements);
  return {
    userId,
    sessionId,
    expiresAt,
    verifiedAt: Date.now(),
    email,
    displayName: "Admission fixture",
    isOperator: operator,
    authEpoch: 0,
  };
}

function serverCommand(name = "Admission server") {
  return {
    commandId: crypto.randomUUID(),
    name,
  };
}

function registration(email = `${crypto.randomUUID()}@example.invalid`) {
  return {
    input: { email, displayName: "Admission account", password: testPassword },
    authorization: {
      authorizationId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
    },
  };
}

describe("instance admission in native primary D1 commits", () => {
  it("admits one account at the last slot under distinct and duplicate races, then recovers its receipt above a lowered cap", async () => {
    const h = identityHarness();
    await h.bootstrap();
    h.mailer.fail = true;
    const limited = { ...env, INSTANCE_ACCOUNT_LIMIT: "2" };
    const first = registration();
    const second = registration();
    const register = (candidate: ReturnType<typeof registration>) =>
      registerAuthorizedAccount(
        candidate.input,
        candidate.authorization,
        limited,
        h.dependencies,
      );
    const outcomes = await Promise.all([
      register(first),
      register(first),
      register(second),
    ]);
    const admitted = outcomes.filter((value) => value.status === "registered");
    expect(new Set(admitted.map((value) => value.userId)).size).toBe(1);
    expect(outcomes.some((value) => value.status === "instance_capacity")).toBe(
      true,
    );
    expect(outcomes[0]).toEqual(outcomes[1]);
    const winner =
      admitted[0]?.userId === first.authorization.userId ? first : second;
    const loser = winner === first ? second : first;
    const counts = await env.IDENTITY_DB.prepare(
      `SELECT (SELECT COUNT(*) FROM identity_user) AS users,
        (SELECT COUNT(*) FROM identity_account) AS credentials,
        (SELECT COUNT(*) FROM identity_registration) AS receipts,
        (SELECT COUNT(*) FROM identity_mail) AS mails,
        (SELECT COUNT(*) FROM identity_token) AS tokens`,
    ).first();
    expect(counts).toEqual({
      users: 2,
      credentials: 2,
      receipts: 1,
      mails: 2,
      tokens: 2,
    });
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT emailVerified FROM identity_user WHERE id = ?",
      )
        .bind(winner.authorization.userId)
        .first("emailVerified"),
    ).toBe(0);
    h.mailer.fail = false;
    expect(
      await registerAuthorizedAccount(
        winner.input,
        winner.authorization,
        { ...limited, INSTANCE_ACCOUNT_LIMIT: "1" },
        h.dependencies,
      ),
    ).toEqual({
      status: "registered",
      userId: winner.authorization.userId,
      mailDelivery: "sent",
    });
    expect(
      await registerAuthorizedAccount(
        { ...winner.input, displayName: "Conflicting retry" },
        winner.authorization,
        limited,
        h.dependencies,
      ),
    ).toEqual({ status: "authorization_conflict" });
    expect(await register(loser)).toEqual({ status: "instance_capacity" });
    expect(
      await registerAuthorizedAccount(
        winner.input,
        loser.authorization,
        limited,
        h.dependencies,
      ),
    ).toEqual({ status: "email_taken" });
  });

  it("retains bootstrap authorization, expiry, singleton and email-conflict precedence at account capacity", async () => {
    const h = identityHarness();
    const occupied = await principal();
    const limited = { ...env, INSTANCE_ACCOUNT_LIMIT: "1" };
    const input = {
      ...registration().input,
      bootstrapSecret: env.OPERATOR_BOOTSTRAP_SECRET,
    };
    expect(
      await bootstrapOperator(
        { ...input, bootstrapSecret: "A".repeat(43) },
        limited,
        h.dependencies,
      ),
    ).toEqual({ status: "forbidden" });
    expect(
      await bootstrapOperator(
        input,
        { ...limited, OPERATOR_BOOTSTRAP_EXPIRES_AT: "2000-01-01T00:00:00Z" },
        h.dependencies,
      ),
    ).toEqual({ status: "bootstrap_expired" });
    await expect(
      bootstrapOperator(
        input,
        { ...limited, INSTANCE_ACCOUNT_LIMIT: "0" },
        h.dependencies,
      ),
    ).rejects.toThrow(/INSTANCE_ACCOUNT_LIMIT/);
    const refused = await h.request("/api/identity/bootstrap", input, {
      environment: limited,
    });
    expect(refused.status).toBe(429);
    expect(await readHttpFailure(refused)).toMatchObject({
      code: "INSTANCE_CAPACITY",
    });
    expect(
      await bootstrapOperator(
        { ...input, email: occupied.email },
        limited,
        h.dependencies,
      ),
    ).toEqual({ status: "email_taken" });
    expect(
      await env.IDENTITY_DB.prepare(
        `SELECT (SELECT COUNT(*) FROM identity_user) AS users,
          (SELECT COUNT(*) FROM identity_operator) AS operators,
          (SELECT COUNT(*) FROM identity_account) AS credentials,
          (SELECT COUNT(*) FROM identity_mail) AS mails`,
      ).first(),
    ).toEqual({ users: 1, operators: 0, credentials: 0, mails: 0 });
    expect(
      await bootstrapOperator(
        input,
        { ...limited, INSTANCE_ACCOUNT_LIMIT: "2" },
        h.dependencies,
      ),
    ).toMatchObject({ status: "registered" });
    expect(await bootstrapOperator(input, limited, h.dependencies)).toEqual({
      status: "bootstrap_complete",
    });
  });

  it("rolls back an account's last-slot receipt on credential failure and leaves that slot retryable", async () => {
    const h = identityHarness();
    await h.bootstrap();
    const limited = { ...env, INSTANCE_ACCOUNT_LIMIT: "2" };
    const candidate = registration();
    await env.IDENTITY_DB.prepare(
      "CREATE TRIGGER fail_admission_credential BEFORE INSERT ON identity_account BEGIN SELECT RAISE(ABORT, 'fixture admission rollback'); END",
    ).run();
    await expect(
      registerAuthorizedAccount(
        candidate.input,
        candidate.authorization,
        limited,
        h.dependencies,
      ),
    ).rejects.toThrow(/fixture admission rollback/);
    expect(
      await env.IDENTITY_DB.prepare(
        `SELECT (SELECT COUNT(*) FROM identity_user) AS users,
          (SELECT COUNT(*) FROM identity_registration) AS receipts,
          (SELECT COUNT(*) FROM identity_mail) AS mails`,
      ).first(),
    ).toEqual({ users: 1, receipts: 0, mails: 1 });
    await env.IDENTITY_DB.prepare(
      "DROP TRIGGER fail_admission_credential",
    ).run();
    expect(
      await registerAuthorizedAccount(
        candidate.input,
        candidate.authorization,
        limited,
        h.dependencies,
      ),
    ).toMatchObject({ status: "registered" });
  });

  it("bounds racing server creations, including duplicate commands and a caller's replica-eligible session", async () => {
    const actor = await principal(true);
    const limited = { ...env, INSTANCE_SERVER_LIMIT: "1" };
    const first = serverCommand();
    const second = serverCommand("Second server");
    const results = await Promise.all([
      createServer(limited, actor, first),
      createServer(limited, actor, first),
      createServer(
        limited,
        actor,
        second,
        env.IDENTITY_DB.withSession("first-unconstrained"),
      ),
    ]);
    const created = results.filter((value) => value.kind === "created");
    expect(new Set(created.map((value) => value.owner.id)).size).toBe(1);
    expect(results[0]).toEqual(results[1]);
    expect(results.some((value) => value.kind === "instance_capacity")).toBe(
      true,
    );
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT kind,lifecycle,COUNT(*) AS count FROM resource_directory GROUP BY kind,lifecycle",
      ).all(),
    ).toMatchObject({
      results: [{ kind: "server", lifecycle: "ready", count: 1 }],
    });
    const winner = results[0]?.kind === "created" ? first : second;
    const denied = await principal();
    expect(await createServer(limited, denied, serverCommand())).toEqual({
      kind: "forbidden",
    });
    expect(
      await createServer(limited, actor, {
        ...winner,
        name: "Changed payload",
      }),
    ).toEqual({ kind: "command_conflict" });
    const other = winner === first ? second : first;
    expect(
      await createServer(
        { ...limited, INSTANCE_SERVER_LIMIT: "2" },
        actor,
        other,
      ),
    ).toMatchObject({ kind: "created" });
    expect(await createServer(limited, actor, winner)).toEqual(created[0]);
    expect(await createServer(limited, actor, serverCommand())).toEqual({
      kind: "instance_capacity",
    });
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_directory",
      ).first("count"),
    ).toBe(2);
    await env.IDENTITY_DB.prepare("DELETE FROM identity_session WHERE id = ?")
      .bind(actor.sessionId)
      .run();
    expect(await createServer(limited, actor, winner)).toEqual({
      kind: "forbidden",
    });
  });

  it("charges interrupted server publication and resumes its accepted receipt at capacity", async () => {
    const actor = await principal(true);
    const limited = { ...env, INSTANCE_SERVER_LIMIT: "1" };
    const command = serverCommand();
    await env.IDENTITY_DB.prepare(
      "CREATE TRIGGER pause_admission_publication BEFORE UPDATE OF lifecycle ON resource_directory BEGIN SELECT RAISE(ABORT, 'fixture pending publication'); END",
    ).run();
    await expect(createServer(limited, actor, command)).rejects.toThrow(
      /fixture pending publication/,
    );
    const pending = await env.IDENTITY_DB.prepare(
      "SELECT id,lifecycle FROM resource_directory",
    ).first<{ id: string; lifecycle: string }>();
    expect(pending?.lifecycle).toBe("pending");
    expect(await createServer(limited, actor, serverCommand())).toEqual({
      kind: "instance_capacity",
    });
    await env.IDENTITY_DB.prepare(
      "DROP TRIGGER pause_admission_publication",
    ).run();
    const resumed = await createServer(limited, actor, command);
    expect(resumed).toMatchObject({
      kind: "created",
      owner: { id: pending?.id },
    });
    expect(await createServer(limited, actor, command)).toEqual(resumed);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM resource_directory",
      ).first("count"),
    ).toBe(1);
  });

  it("charges pending conversations and recovers the same canonical pair from either participant without charging another slot", async () => {
    const [alice, bob, carol] = await Promise.all([
      principal(),
      principal(),
      principal(),
    ]);
    const limited = { ...env, INSTANCE_CONVERSATION_LIMIT: "1" };
    await env.IDENTITY_DB.prepare(
      "CREATE TRIGGER pause_pair_publication BEFORE UPDATE OF lifecycle ON resource_directory BEGIN SELECT RAISE(ABORT, 'fixture pending pair'); END",
    ).run();
    await expect(
      createConversation(limited, alice, bob.userId),
    ).rejects.toThrow(/fixture pending pair/);
    const denied = await Promise.all([
      createConversation(limited, alice, carol.userId),
      createConversation(limited, bob, carol.userId),
    ]);
    expect(denied).toEqual([
      { kind: "instance_capacity" },
      { kind: "instance_capacity" },
    ]);
    expect(
      await createConversation(limited, alice, crypto.randomUUID()),
    ).toEqual({
      kind: "not_found",
    });
    await env.IDENTITY_DB.prepare("DROP TRIGGER pause_pair_publication").run();
    const recovered = await Promise.all([
      createConversation(limited, alice, bob.userId),
      createConversation(limited, bob, alice.userId),
    ]);
    expect(recovered[0]).toMatchObject({ kind: "created" });
    expect(recovered[1]).toEqual(recovered[0]);
    expect(
      await env.IDENTITY_DB.prepare(
        `SELECT (SELECT COUNT(*) FROM resource_directory) AS resources,
          (SELECT COUNT(*) FROM resource_membership_index) AS memberships`,
      ).first(),
    ).toEqual({ resources: 1, memberships: 2 });
  });

  it("produces typed HTTP refusal without owner dispatch for rejected capacity or unrecognized owner and account IDs", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const existing = await h.createServer(operator);
    const limited = { ...env, INSTANCE_SERVER_LIMIT: "1" };
    const body = { ...existing, commandId: crypto.randomUUID() };
    const serverBinding = vi.spyOn(env.SERVER_DO, "getByName");
    const conversationBinding = vi.spyOn(env.CONVERSATION_DO, "getByName");
    const mediaBinding = vi.spyOn(env.MEDIA_ROOM, "getByName");
    try {
      const response = await h.app.request(
        `${env.AUTH_ORIGIN}/api/servers`,
        {
          method: "POST",
          headers: {
            Origin: env.AUTH_ORIGIN,
            Cookie: operator.cookie,
            "Content-Type": "application/json",
            "CF-Connecting-IP": operator.address,
          },
          body: JSON.stringify({
            commandId: body.commandId,
            name: body.name,
          }),
        },
        limited,
      );
      expect(response.status).toBe(429);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "INSTANCE_CAPACITY",
      });
      const id = crypto.randomUUID();
      const channelId = crypto.randomUUID();
      for (const kind of ["server", "conversation"]) {
        const path = `/api/resources/${kind}/${id}`;
        for (const suffix of [
          "",
          "/capacity",
          `/files/${crypto.randomUUID()}/status`,
        ])
          expect((await operator.request(`${path}${suffix}`)).status).toBe(404);
        expect(
          (await operator.request(`${path}/snapshot`, { channelId })).status,
        ).toBe(404);
        expect(
          (
            await operator.request("/api/media/snapshot", {
              room: { owner: { kind, id }, channelId },
            })
          ).status,
        ).toBe(404);
      }
      expect(
        (await operator.request(`/api/servers/${id}/channels`, {})).status,
      ).toBe(400);
      const missingServer = await operator.request(
        `/api/servers/${id}/channels`,
        {
          channelId,
          name: "Unknown server room",
          private: false,
          expectedVersion: 1,
        },
      );
      expect(missingServer.status).toBe(404);
      expect(await readHttpFailure(missingServer)).toMatchObject({
        code: "NOT_FOUND",
      });
      expect((await operator.request(`/api/account/blocks/${id}`)).status).toBe(
        404,
      );
      expect(serverBinding).not.toHaveBeenCalled();
      expect(conversationBinding).not.toHaveBeenCalled();
      expect(mediaBinding).not.toHaveBeenCalled();
    } finally {
      serverBinding.mockRestore();
      conversationBinding.mockRestore();
      mediaBinding.mockRestore();
    }
  });
});
