import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  NotificationOutcomeSchema,
  type NotificationState,
  type PushSubscription,
} from "@vaskel/contracts/notifications";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import { base64url } from "@/server/auth/crypto";
import {
  applicationHarness,
  decodeApplicationResponse,
  type ApplicationClient,
} from "@tests/helpers/application-harness";

const path = "/api/notifications";
const commands = `${path}/commands`;

async function state(client: ApplicationClient): Promise<NotificationState> {
  const result = await decodeApplicationResponse(
    await client.request(path),
    NotificationOutcomeSchema,
  );
  if (result.kind !== "notification_state")
    throw new Error(`Notification state failed: ${result.kind}`);
  return result.state;
}

async function subscription(): Promise<PushSubscription> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  if (!("publicKey" in keys)) throw new Error("Expected subscription key pair");
  const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("Expected raw key bytes");
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: base64url(new Uint8Array(raw)),
      auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

describe("authenticated notification management HTTP", () => {
  it("binds enrollments and public state to the signed-in account", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member } = await h.registerMember(operator, server.owner.id);
    const first = await state(operator);
    const other = await state(member);
    expect(first.accountId).toBe(operator.profile!.userId);
    expect(other.accountId).toBe(member.profile!.userId);
    expect(first.publicKey).not.toBe(other.publicKey);
    const enable = {
      kind: "enable",
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedRevision: first.revision,
      deviceId: crypto.randomUUID(),
      label: " Desktop ",
      language: "en",
      subscription: await subscription(),
    };
    const response = await operator.request(commands, enable);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const updated = await decodeApplicationResponse(
      response,
      NotificationOutcomeSchema,
    );
    expect(updated.kind).toBe("notification_updated");
    const current = await state(operator);
    expect(current.devices).toMatchObject([
      { deviceId: enable.deviceId, label: "Desktop" },
    ]);
    expect(JSON.stringify(current)).not.toContain(enable.subscription.endpoint);
    expect(JSON.stringify(current)).not.toContain(
      enable.subscription.keys.auth,
    );
    expect((await state(member)).devices).toEqual([]);
    // The browser's account precondition cannot turn a replacement cookie into
    // authority for the enrollment that was captured before the account changed.
    expect(
      (
        await member.request(commands, enable, {
          headers: { [EXPECTED_ACCOUNT_HEADER]: first.accountId },
        })
      ).status,
    ).toBe(401);
    await operator.request("/api/identity/sign-out", {});
    expect((await operator.request(path)).status).toBe(401);
    await h.signIn(operator, "operator@example.invalid");
    expect((await state(operator)).devices).toEqual(current.devices);
  });

  it("authenticates and rate limits a status read once", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const limiter = vi.spyOn(env.APPLICATION_RATE_LIMITER, "limit");
    const native = env.IDENTITY_DB.withSession.bind(env.IDENTITY_DB);
    let authorityReads = 0;
    const sessions = vi
      .spyOn(env.IDENTITY_DB, "withSession")
      .mockImplementation((bookmark) => {
        const session = native(bookmark);
        const prepare = session.prepare.bind(session);
        session.prepare = (query) => {
          if (query.includes('"identity_session" as "s"')) authorityReads++;
          return prepare(query);
        };
        return session;
      });
    try {
      await state(operator);
      expect(limiter).toHaveBeenCalledTimes(1);
      expect(authorityReads).toBe(1);
    } finally {
      limiter.mockRestore();
      sessions.mockRestore();
    }
  });

  it("retains origin, authentication, strict input and rate gates and exposes no delivery RPC", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const preferences = {
      kind: "preferences",
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedRevision: 0,
      paused: false,
      preview: "generic",
      language: "en",
    };
    expect((await h.anonymous.request(path)).status).toBe(401);
    expect((await h.anonymous.request(commands, preferences)).status).toBe(401);
    expect(
      (await operator.request(commands, preferences, { origin: null })).status,
    ).toBe(403);
    expect(
      (
        await operator.request(commands, preferences, {
          origin: "https://foreign.invalid",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await operator.request(commands, {
          ...preferences,
          accountId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await operator.request(commands, undefined, { rawBody: "{" })).status,
    ).toBe(400);
    expect(
      (
        await operator.request(commands, undefined, {
          rawBody: "x".repeat(256 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    const limit = vi
      .spyOn(env.APPLICATION_RATE_LIMITER, "limit")
      .mockResolvedValueOnce({ success: false });
    try {
      expect((await operator.request(commands, preferences)).status).toBe(429);
    } finally {
      limit.mockRestore();
    }
    expect((await operator.request(`${path}/resolve`, {})).status).toBe(404);
    expect((await state(operator)).revision).toBe(0);
  });

  it("does not extend the normal actor assertion during delayed management dispatch", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const original = await state(operator);
    const now = Date.now();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const limit = vi
      .spyOn(env.APPLICATION_RATE_LIMITER, "limit")
      .mockImplementationOnce(async () => {
        clock = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
        return { success: true };
      });
    try {
      expect(
        (
          await operator.request(commands, {
            kind: "preferences",
            commandId: crypto.randomUUID(),
            issuedAt: now,
            expectedRevision: original.revision,
            paused: true,
            preview: "message",
            language: "ja",
          })
        ).status,
      ).toBe(401);
    } finally {
      clock?.mockRestore();
      limit.mockRestore();
    }
    expect((await state(operator)).preferences).toEqual(original.preferences);
  });
});
