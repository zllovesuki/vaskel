import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { createTestHarness, type TestHarness } from "wrangler";
import { fixtureAuthVars } from "@tests/config/bindings";
import {
  RegisterAccountResponseSchema,
  SignInResponseSchema,
  VerifyEmailResponseSchema,
  type IdentityProfile,
} from "@vaskel/contracts/identity";
import {
  InviteRegistrationResponseSchema,
  ResourceCreatedSchema,
} from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import {
  MessagingOutcomeSchema,
  type Message,
  type OwnerScope,
} from "@vaskel/contracts/messaging";

export const password = "synthetic browser acceptance passphrase";
export type Account = {
  email: string;
  cookie: string;
  profile: IdentityProfile;
  address: string;
};
export type Room = { owner: OwnerScope; channelId: string; name: string };
export const roomPath = (room: Room) =>
  room.owner.kind === "server"
    ? `/servers/${room.owner.id}/channels/${room.channelId}`
    : `/conversations/${room.owner.id}`;
export const apiPath = (room: Room) =>
  `/api/resources/${room.owner.kind}/${room.owner.id}`;

export class BrowserApplication {
  origin = "";
  owner!: Account;
  member!: Account;
  circle!: Room;
  dm!: Room;
  constructor(readonly server: TestHarness) {}

  async request(
    account: Account | null,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await this.server.fetch(`${this.origin}${path}`, {
      method,
      headers: {
        Origin: this.origin,
        "Content-Type": "application/json",
        "CF-Connecting-IP": account?.address ?? "2001:db8::10",
        ...(account ? { Cookie: account.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    assert.ok(
      response.ok,
      `${path}: HTTP ${response.status} ${JSON.stringify(result)}`,
    );
    return { response, result };
  }

  /** The latest emailed link's token for this address, left unused. */
  async mailedToken(kind: "verify-email" | "reset-password", email: string) {
    const mail = (await this.server
      .getWorker("vaskel-browser-mail")
      .getExport()) as unknown as {
      token(kind: string, email: string): Promise<string | null>;
    };
    await expect.poll(() => mail.token(kind, email)).not.toBeNull();
    const token = await mail.token(kind, email);
    assert.ok(token);
    return token;
  }

  async verify(email: string) {
    const { result } = await this.request(null, "/api/identity/verify-email", {
      token: await this.mailedToken("verify-email", email),
    });
    assert.equal(
      VerifyEmailResponseSchema.parse(result).status,
      "email_verified",
    );
  }

  async signIn(email: string): Promise<Account> {
    const { response, result } = await this.request(
      null,
      "/api/identity/sign-in",
      { email, password },
    );
    const parsed = SignInResponseSchema.parse(result);
    assert.equal(parsed.status, "authenticated");
    if (parsed.status !== "authenticated")
      throw new Error("Synthetic sign-in failed");
    return {
      email,
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
      profile: parsed.user,
      address: `2001:db8:${randomUUID().slice(0, 4)}::1`,
    };
  }

  async seed() {
    const email = "host@browser.invalid";
    const { result } = await this.request(null, "/api/identity/bootstrap", {
      email,
      displayName: "Browser Host",
      password,
      bootstrapSecret: fixtureAuthVars.OPERATOR_BOOTSTRAP_SECRET,
    });
    assert.equal(
      RegisterAccountResponseSchema.parse(result).status,
      "registered",
    );
    await this.verify(email);
    this.owner = await this.signIn(email);
    const created = ResourceCreatedSchema.parse(
      (
        await this.request(this.owner, "/api/servers", {
          commandId: randomUUID(),
          name: "Browser Circle",
          firstChannelName: "General",
        })
      ).result,
    );
    if (created.kind !== "created")
      throw new Error("Synthetic circle creation failed");
    this.circle = {
      owner: created.owner,
      channelId: created.channelId,
      name: "General",
    };
    const invitation = AdministrationOutcomeSchema.parse(
      (
        await this.request(
          this.owner,
          `/api/servers/${created.owner.id}/invites`,
          {
            expiresAt: Date.now() + 3_600_000,
            maxUses: 1,
          },
        )
      ).result,
    );
    if (invitation.kind !== "invite_created")
      throw new Error("Synthetic invitation failed");
    const memberEmail = "member@browser.invalid";
    const registered = InviteRegistrationResponseSchema.parse(
      (
        await this.request(null, "/api/invites/register", {
          token: invitation.token,
          registrationId: randomUUID(),
          email: memberEmail,
          displayName: "Browser Member",
          password,
        })
      ).result,
    );
    assert.ok("status" in registered && registered.status === "registered");
    await this.verify(memberEmail);
    this.member = await this.signIn(memberEmail);
    await this.request(this.member, "/api/invites/join", {
      token: invitation.token,
    });
    const dm = ResourceCreatedSchema.parse(
      (
        await this.request(this.owner, "/api/conversations", {
          userId: this.member.profile.userId,
        })
      ).result,
    );
    if (dm.kind !== "created") throw new Error("Synthetic conversation failed");
    this.dm = {
      owner: dm.owner,
      channelId: dm.channelId,
      name: "Browser Member",
    };
  }

  async room(name: string, kind: "text" | "media" = "text"): Promise<Room> {
    const directory = DirectoryOutcomeSchema.parse(
      (await this.request(this.owner, apiPath(this.circle))).result,
    );
    if (directory.kind !== "directory")
      throw new Error("Synthetic directory unavailable");
    const channelId = randomUUID();
    await this.request(
      this.owner,
      `/api/servers/${this.circle.owner.id}/channels`,
      {
        channelId,
        name,
        kind,
        private: false,
        expectedVersion: directory.version,
      },
    );
    return { owner: this.circle.owner, channelId, name };
  }

  async sendReceipt(account: Account, room: Room, body: string) {
    const parsed = MessagingOutcomeSchema.parse(
      (
        await this.request(account, `${apiPath(room)}/send`, {
          channelId: room.channelId,
          commandId: randomUUID(),
          issuedAt: Date.now(),
          body,
        })
      ).result,
    );
    if (parsed.kind !== "accepted") throw new Error("Synthetic send failed");
    return parsed.receipt;
  }

  async send(account: Account, room: Room, body: string): Promise<Message> {
    const receipt = await this.sendReceipt(account, room, body);
    const message = (await this.snapshot(account, room)).messages.find(
      (row) => row.id === receipt.messageId,
    );
    assert.ok(
      message,
      "Accepted send must be present in the authoritative snapshot",
    );
    return message;
  }

  async snapshot(account: Account, room: Room) {
    const parsed = MessagingOutcomeSchema.parse(
      (
        await this.request(account, `${apiPath(room)}/snapshot`, {
          channelId: room.channelId,
        })
      ).result,
    );
    if (parsed.kind !== "snapshot")
      throw new Error("Synthetic snapshot failed");
    return parsed;
  }

  async remove(account: Account, room: Room, message: Message) {
    await this.request(account, `${apiPath(room)}/delete`, {
      channelId: room.channelId,
      messageId: message.id,
      expectedVersion: message.version,
      commandId: randomUUID(),
      issuedAt: Date.now(),
    });
  }

  async role(role: "member" | "moderator") {
    const directory = DirectoryOutcomeSchema.parse(
      (await this.request(this.owner, apiPath(this.circle))).result,
    );
    if (directory.kind !== "directory")
      throw new Error("Synthetic directory unavailable");
    await this.request(
      this.owner,
      `/api/servers/${this.circle.owner.id}/set-role`,
      {
        userId: this.member.profile.userId,
        role,
        expectedVersion: directory.version,
      },
    );
  }

  async invitePolicy(membersMayInvite: boolean) {
    const directory = DirectoryOutcomeSchema.parse(
      (await this.request(this.owner, apiPath(this.circle))).result,
    );
    if (directory.kind !== "directory")
      throw new Error("Synthetic directory unavailable");
    await this.request(
      this.owner,
      `/api/servers/${this.circle.owner.id}/settings`,
      {
        membersMayInvite,
        expectedVersion: directory.version,
      },
    );
  }

  async open(page: Page, account: Account, path: string) {
    await page.goto(`${this.origin}${path}`);
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Account options", exact: true }),
    ).toBeVisible();
  }
}

async function application(seeded: boolean) {
  const root = resolve(import.meta.dirname, "../..");
  const notes = resolve(root, ".local/browser-runs");
  await mkdir(notes, { recursive: true });
  const directory = await mkdtemp(resolve(notes, "run-"));
  const builtRoot = resolve(root, "apps/client/dist/vaskel");
  const built = JSON.parse(
    await readFile(resolve(builtRoot, "wrangler.json"), "utf8"),
  ) as Record<string, unknown>;
  const config = {
    name: "vaskel-browser",
    main: resolve(builtRoot, "index.js"),
    compatibility_date: built.compatibility_date,
    compatibility_flags: built.compatibility_flags,
    rules: built.rules,
    no_bundle: true,
    assets: {
      ...(built.assets as object),
      directory: resolve(root, "apps/client/dist/client"),
    },
    durable_objects: built.durable_objects,
    migrations: built.migrations,
    // The browser fixture accepts encrypted jobs but has no provider consumer.
    // Native transport tests separately exercise provider responses and retries.
    queues: {
      producers: [{ binding: "PUSH_QUEUE", queue: "vaskel-push-browser" }],
    },
    r2_buckets: built.r2_buckets,
    ratelimits: built.ratelimits,
    version_metadata: built.version_metadata,
    d1_databases: [
      {
        binding: "IDENTITY_DB",
        database_name: "browser-identity",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: resolve(root, "apps/server/migrations/d1"),
      },
    ],
    services: [{ binding: "EMAIL", service: "vaskel-browser-mail" }],
    vars: fixtureAuthVars,
  };
  const configPath = resolve(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const mailPath = resolve(directory, "mail.mjs");
  await writeFile(
    mailPath,
    `import { WorkerEntrypoint } from "cloudflare:workers";
const tokens = new Map();
export default class BrowserMail extends WorkerEntrypoint {
  send(message) {
    const match = message.text.match(/https?:\\/\\/[^\\s]+\\/(verify-email|reset-password)\\?token=([A-Za-z0-9_-]+)/);
    if (match) tokens.set(match[1] + " " + message.to, match[2]);
  }
  token(kind, email) { return tokens.get(kind + " " + email) ?? null; }
  fetch() { return new Response(null, { status: 404 }); }
}`,
  );
  const options = (origin = "http://localhost:5173") => ({
    root: directory,
    workers: [
      {
        configPath,
        vars: { ...fixtureAuthVars, AUTH_ORIGIN: origin },
        secrets: { ...fixtureAuthVars, AUTH_ORIGIN: origin },
      },
      {
        config: {
          name: "vaskel-browser-mail",
          main: mailPath,
          compatibility_date: "2026-09-16",
        },
      },
    ],
  });
  const server = createTestHarness(options());
  try {
    const { url } = await server.listen();
    await server.update(options(url.origin));
    await server.getWorker().applyD1Migrations("IDENTITY_DB");
    const app = new BrowserApplication(server);
    app.origin = url.origin;
    if (seeded) await app.seed();
    return {
      app,
      async close() {
        await server.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const test = base.extend<{ app: BrowserApplication; seeded: boolean }>({
  seeded: [true, { option: true }],
  app: [
    async ({ browserName, seeded }, use) => {
      if (browserName !== "chromium")
        throw new Error(
          "The local browser acceptance matrix currently targets Chromium.",
        );
      const fixture = await application(seeded);
      try {
        await use(fixture.app);
      } finally {
        await fixture.close();
      }
    },
    { timeout: 60_000 },
  ],
});
export { expect };
