import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import {
  INSTANCE_ICON_BYTE_LIMIT,
  OperatorAccountsOutcomeSchema,
  OperatorInstanceOutcomeSchema,
  OperatorUsageOutcomeSchema,
  PublicInstanceSchema,
} from "@vaskel/contracts/instance";
import {
  applicationHarness,
  decodeApplicationResponse,
} from "@tests/helpers/application-harness";
import { cleanupInstanceIcons } from "@/server/instance/icons";

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

function iconRequest(
  h: ReturnType<typeof applicationHarness>,
  cookie: string,
  bytes: Uint8Array = png,
  contentType = "image/png",
  environment = h.environment,
) {
  return h.app.request(
    "https://vaskel.test/api/operator/instance/icon",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://vaskel.test",
        "Content-Type": contentType,
      },
      body: new Uint8Array(bytes),
    },
    environment,
  );
}

describe("operator administration and public branding HTTP", () => {
  it("provides only public branding, guards all administration, and combines instance/server invite policy without invalidating old invites", async () => {
    const h = applicationHarness();
    expect(
      await decodeApplicationResponse(
        await h.anonymous.request("/api/instance", undefined, { origin: null }),
        PublicInstanceSchema,
      ),
    ).toEqual({ name: "vaskel.", hasIcon: false });
    expect(
      (
        await h.anonymous.request("/api/instance/icon", undefined, {
          origin: null,
        })
      ).status,
    ).toBe(404);
    const operator = await h.bootstrap();
    const versionResponse = await h.app.request(
      "https://vaskel.test/api/operator/instance",
      { headers: { Cookie: operator.cookie } },
      {
        ...h.environment,
        CF_VERSION_METADATA: {
          ...h.environment.CF_VERSION_METADATA,
          tag: "754080e",
        },
      },
    );
    expect(versionResponse.status).toBe(200);
    expect(
      await decodeApplicationResponse(
        versionResponse,
        OperatorInstanceOutcomeSchema,
      ),
    ).toMatchObject({ kind: "instance", tag: "754080e" });
    const server = await h.createServer(operator);
    const { member, joined } = await h.registerMember(
      operator,
      server.owner.id,
    );
    for (const path of ["instance", "accounts", "usage"]) {
      expect((await h.anonymous.request(`/api/operator/${path}`)).status).toBe(
        401,
      );
      expect((await member.request(`/api/operator/${path}`)).status).toBe(403);
    }
    expect(
      (
        await member.request("/api/operator/instance", {
          name: "Bad",
          invitePolicy: "owners",
        })
      ).status,
    ).toBe(403);
    expect((await iconRequest(h, member.cookie)).status).toBe(403);
    const inviteInput = { expiresAt: Date.now() + 60_000 };
    const old = await member.request(
      `/api/servers/${server.owner.id}/invites`,
      inviteInput,
    );
    expect(old.status).toBe(200);
    const oldInvite = (await old.json()) as { token: string };
    expect(
      await decodeApplicationResponse(
        await operator.request("/api/operator/instance", {
          name: " Our space ",
          invitePolicy: "owners",
        }),
        OperatorInstanceOutcomeSchema,
      ),
    ).toEqual({
      kind: "instance",
      name: "Our space",
      hasIcon: false,
      invitePolicy: "owners",
      tag: h.environment.CF_VERSION_METADATA.tag || null,
    });
    expect(
      (
        await member.request(
          `/api/servers/${server.owner.id}/invites`,
          inviteInput,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await operator.request(
          `/api/servers/${server.owner.id}/invites`,
          inviteInput,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.anonymous.request("/api/invites/inspect", {
          token: oldInvite.token,
        })
      ).status,
    ).toBe(200);
    expect(
      await decodeApplicationResponse(
        await h.anonymous.request("/api/instance"),
        PublicInstanceSchema,
      ),
    ).toEqual({ name: "Our space", hasIcon: false });
    expect(
      (
        await operator.request(`/api/servers/${server.owner.id}/settings`, {
          membersMayInvite: false,
          expectedVersion: joined.version,
        })
      ).status,
    ).toBe(200);
    await operator.request("/api/operator/instance", {
      name: "Our space",
      invitePolicy: "members",
    });
    expect(
      (
        await member.request(
          `/api/servers/${server.owner.id}/invites`,
          inviteInput,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await operator.request("/api/operator/instance", {
          name: " ",
          invitePolicy: "owners",
        })
      ).status,
    ).toBe(400);
  });

  it("validates raster uploads and bounds bytes, publishes privately stored icons, and sweeps replaced bytes", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    for (const [bytes, mime, status] of [
      [
        new TextEncoder().encode('<svg onload="alert(1)"/>'),
        "image/svg+xml",
        400,
      ],
      [png, "text/html", 400],
      [new Uint8Array(30), "image/png", 400],
      [new Uint8Array(INSTANCE_ICON_BYTE_LIMIT + 1), "image/png", 413],
    ] as const)
      expect((await iconRequest(h, operator.cookie, bytes, mime)).status).toBe(
        status,
      );
    expect(
      (await h.environment.ATTACHMENTS.list({ prefix: "instance-icons/" }))
        .objects,
    ).toHaveLength(0);
    expect((await iconRequest(h, operator.cookie)).status).toBe(200);
    const publicIcon = await h.anonymous.request(
      "/api/instance/icon",
      undefined,
      { origin: null },
    );
    expect(publicIcon.headers.get("Content-Type")).toBe("image/png");
    expect(publicIcon.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(publicIcon.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await publicIcon.arrayBuffer())).toEqual(png);
    expect((await iconRequest(h, operator.cookie)).status).toBe(200);
    expect(
      await cleanupInstanceIcons(h.environment, Date.now() + 11 * 60_000),
    ).toBe(1);
    expect(
      (await h.environment.ATTACHMENTS.list({ prefix: "instance-icons/" }))
        .objects,
    ).toHaveLength(1);
    expect((await h.anonymous.request("/api/instance/icon")).status).toBe(200);
  });

  it("rejects publication after revocation during R2 and durably cleans uncertain writes after failures", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const bucket = h.environment.ATTACHMENTS;
    const delayed = new Proxy(bucket, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const result = await target.put(...args);
            await h.environment.IDENTITY_DB.prepare(
              "DELETE FROM identity_session WHERE userId = ?",
            )
              .bind(operator.profile!.userId)
              .run();
            return result;
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      (
        await iconRequest(h, operator.cookie, png, "image/png", {
          ...h.environment,
          ATTACHMENTS: delayed,
        })
      ).status,
    ).toBe(403);
    expect(
      await decodeApplicationResponse(
        await h.anonymous.request("/api/instance"),
        PublicInstanceSchema,
      ),
    ).toEqual({ name: "vaskel.", hasIcon: false });
    expect(
      await cleanupInstanceIcons(h.environment, Date.now() + 11 * 60_000),
    ).toBe(1);
    await h.signIn(operator, "operator@example.invalid");
    const failed = new Proxy(bucket, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await target.put(...args);
            throw new Error("uncertain R2 completion");
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      (
        await iconRequest(h, operator.cookie, png, "image/png", {
          ...h.environment,
          ATTACHMENTS: failed,
        })
      ).status,
    ).toBe(500);
    expect(
      await cleanupInstanceIcons(h.environment, Date.now() + 11 * 60_000),
    ).toBe(1);
    expect(
      (await h.environment.ATTACHMENTS.list({ prefix: "instance-icons/" }))
        .objects,
    ).toHaveLength(0);
  });

  it("leaves an unchanged icon cleanup cursor unwritten", async () => {
    const h = applicationHarness();
    await h.environment.IDENTITY_DB.prepare(
      "CREATE TRIGGER reject_unchanged_icon_cursor BEFORE UPDATE OF icon_cleanup_cursor ON instance_settings WHEN NEW.icon_cleanup_cursor IS OLD.icon_cleanup_cursor BEGIN SELECT RAISE(ABORT, 'unchanged_icon_cursor_write'); END",
    ).run();
    expect(await cleanupInstanceIcons(h.environment)).toBe(0);
    expect(await cleanupInstanceIcons(h.environment)).toBe(0);
  });

  it("retries bounded icon cleanup after R2 failure and revisits keys written after a sweep", async () => {
    const h = applicationHarness();
    const oldPrefix = `instance-icons/${Date.now() - 11 * 60_000}/`;
    const keys = Array.from(
      { length: 51 },
      (_, i) => `${oldPrefix}${i.toString().padStart(3, "0")}`,
    );
    await Promise.all(
      keys.map((key) => h.environment.ATTACHMENTS.put(key, png)),
    );
    const bucket = h.environment.ATTACHMENTS;
    const failedDelete = new Proxy(bucket, {
      get(target, property) {
        if (property === "delete")
          return async () => {
            throw new Error("interrupted cleanup");
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      cleanupInstanceIcons({ ...h.environment, ATTACHMENTS: failedDelete }),
    ).rejects.toThrow("interrupted cleanup");
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT icon_cleanup_cursor FROM instance_settings WHERE id = 1",
      ).first("icon_cleanup_cursor"),
    ).toBeNull();
    expect(await cleanupInstanceIcons(h.environment)).toBe(50);
    expect(await cleanupInstanceIcons(h.environment)).toBe(1);
    await bucket.put(keys[0]!, png);
    expect(await cleanupInstanceIcons(h.environment)).toBe(1);
    expect(
      (await bucket.list({ prefix: "instance-icons/" })).objects,
    ).toHaveLength(0);
  });

  it("reports aggregate usage for hidden owners without disclosing names or participants, preserving owner capacity authorization", async () => {
    const h = applicationHarness();
    const { operator, first, second, alice, bob } = await h.twoServers();
    const conversation = (await (
      await alice.member.request("/api/conversations", {
        userId: bob.registered.userId,
      })
    ).json()) as { owner: { id: string } };
    await runInDurableObject(
      h.environment.CONVERSATION_DO.getByName(conversation.owner.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE owner_state SET attachment_bytes = 1234",
        );
      },
    );
    const transfer = await operator.request(
      `/api/servers/${first.owner.id}/transfer`,
      {
        userId: alice.registered.userId,
        expectedVersion: alice.joined.version,
      },
    );
    expect(transfer.status).toBe(200);
    expect((await operator.request(`${first.path}/capacity`)).status).toBe(403);
    // Block-only pair identifiers are deliberately absent from the host inventory.
    const blocked = await operator.request(
      `/api/account/blocks/${alice.registered.userId}`,
      {
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
        blocked: true,
        expectedRevision: 0,
      },
      { method: "PUT" },
    );
    expect(blocked.status).toBe(200);
    const blockPairId = await h.environment.IDENTITY_DB.prepare(
      "SELECT conversation_id FROM block_candidates WHERE user_id = ? AND target_id = ?",
    )
      .bind(operator.profile!.userId, alice.registered.userId)
      .first<string>("conversation_id");
    const response = await operator.request("/api/operator/usage");
    const result = await decodeApplicationResponse(
      response,
      OperatorUsageOutcomeSchema,
    );
    if (result.kind !== "usage") throw new Error(result.kind);
    expect(result.partial).toBe(false);
    expect(result.nextAfter).toBeNull();
    expect(result.owners.map((row) => row.owner.id).sort()).toEqual(
      [first.owner.id, second.owner.id, conversation.owner.id].sort(),
    );
    expect(
      result.owners.find((row) => row.owner.id === conversation.owner.id)
        ?.attachments,
    ).toMatchObject({ chargedBytes: 1234 });
    expect(result.owners.map((row) => row.owner.id)).not.toContain(blockPairId);
    const serialized = JSON.stringify(result);
    for (const secret of [
      alice.registered.userId,
      bob.registered.userId,
      "Alice",
      "Bob",
      "First server",
      "participant",
    ])
      expect(serialized).not.toContain(secret);
    expect(
      (
        await operator.request(
          `/api/resources/conversation/${conversation.owner.id}/members`,
        )
      ).status,
    ).toBe(403);
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(first.owner.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "ALTER TABLE owner_state RENAME TO unavailable_owner_state",
        );
      },
    );
    const partial = await decodeApplicationResponse(
      await operator.request("/api/operator/usage"),
      OperatorUsageOutcomeSchema,
    );
    expect(partial).toMatchObject({
      kind: "usage",
      partial: true,
      nextAfter: null,
    });
    if (partial.kind === "usage") expect(partial.owners).toHaveLength(2);
  });

  it("paginates safe account rows and owner coverage with bounded stable cursors", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const db = h.environment.IDENTITY_DB;
    const ids = Array.from({ length: 25 }, () => crypto.randomUUID());
    await db.batch(
      ids.flatMap((id) => [
        db
          .prepare(
            "INSERT INTO identity_user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'Safe name', ?, 0, '2026-09-17T00:00:00.000Z', 'fixture')",
          )
          .bind(id, `${id}@example.invalid`),
        db
          .prepare(
            "INSERT INTO resource_directory (id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?, 'server', 'Hidden name', ?, 'ready', 'fixture', 0)",
          )
          .bind(id, operator.profile!.userId),
      ]),
    );
    const first = await decodeApplicationResponse(
      await operator.request("/api/operator/accounts"),
      OperatorAccountsOutcomeSchema,
    );
    if (first.kind !== "accounts") throw new Error(first.kind);
    expect(first.accounts).toHaveLength(20);
    expect(first.partial).toBe(true);
    const second = await decodeApplicationResponse(
      await operator.request(`/api/operator/accounts?after=${first.nextAfter}`),
      OperatorAccountsOutcomeSchema,
    );
    if (second.kind !== "accounts") throw new Error(second.kind);
    expect(second.accounts).toHaveLength(6);
    expect(second.partial).toBe(false);
    expect(
      new Set([...first.accounts, ...second.accounts].map((row) => row.id))
        .size,
    ).toBe(26);
    expect(JSON.stringify([first, second])).not.toContain("@example.invalid");
    const usage = await decodeApplicationResponse(
      await operator.request("/api/operator/usage"),
      OperatorUsageOutcomeSchema,
    );
    expect(usage).toMatchObject({
      kind: "usage",
      owners: [],
      partial: true,
      nextAfter: ids.sort()[19],
    });
    expect(
      (await operator.request("/api/operator/accounts?after=invalid")).status,
    ).toBe(400);
  });
});
