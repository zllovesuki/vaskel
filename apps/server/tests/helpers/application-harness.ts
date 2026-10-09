import { readHttpFailure } from "@tests/helpers/http";
import { messageEnvelope } from "@tests/helpers/messaging";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect } from "vitest";
import type { z } from "zod";
import { createHttpApp } from "@/server/http";
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
import {
  ServerEventSchema,
  type OwnerScope,
  type ServerEvent,
} from "@vaskel/contracts/messaging";
import {
  CapturedIdentityMailer,
  testPassword,
} from "@tests/helpers/identity-harness";

export interface ApplicationRequestOptions {
  method?: string;
  origin?: string | null;
  bookmark?: string;
  headers?: HeadersInit;
  rawBody?: string;
}
export interface ApplicationClient {
  cookie: string;
  bookmark: string | undefined;
  profile: IdentityProfile | undefined;
  address: string;
  request(
    path: string,
    body?: unknown,
    options?: ApplicationRequestOptions,
  ): Promise<Response>;
}

export async function decodeApplicationResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (!response.ok) throw await readHttpFailure(response);
  return schema.parse(await response.json());
}
export function resourcePath(owner: OwnerScope): string {
  return `/api/resources/${owner.kind}/${owner.id}`;
}
export function messageCommand(
  channelId: string,
  body = "東京都で会話を続ける",
) {
  return { ...messageEnvelope(channelId), body };
}

export function applicationHarness() {
  const environment: Env = env;
  const mailer = new CapturedIdentityMailer();
  const app = createHttpApp({ identity: { mailer } });
  function client(): ApplicationClient {
    const connection: ApplicationClient = {
      cookie: "",
      bookmark: undefined,
      profile: undefined,
      address: `2001:db8:${crypto.randomUUID().slice(0, 4)}:${crypto.randomUUID().slice(0, 4)}::1`,
      async request(path, body, options = {}) {
        const headers = new Headers({
          "Content-Type": "application/json",
          "CF-Connecting-IP": connection.address,
        });
        if (options.origin !== null)
          headers.set("Origin", options.origin ?? environment.AUTH_ORIGIN);
        if (connection.cookie) headers.set("Cookie", connection.cookie);
        const bookmark = options.bookmark ?? connection.bookmark;
        if (bookmark) headers.set("X-Vaskel-D1-Bookmark", bookmark);
        new Headers(options.headers).forEach((value, key) =>
          headers.set(key, value),
        );
        const executionContext = createExecutionContext();
        const payload =
          options.rawBody ??
          (body === undefined ? undefined : JSON.stringify(body));
        const response = await app.request(
          `${environment.AUTH_ORIGIN}${path}`,
          {
            method: options.method ?? (payload === undefined ? "GET" : "POST"),
            headers,
            ...(payload === undefined ? {} : { body: payload }),
          },
          environment,
          executionContext,
        );
        await waitOnExecutionContext(executionContext);
        const nextBookmark = response.headers.get("X-Vaskel-D1-Bookmark");
        if (nextBookmark) connection.bookmark = nextBookmark;
        return response;
      },
    };
    return connection;
  }
  const anonymous = client();
  async function signIn(connection: ApplicationClient, email: string) {
    const response = await connection.request("/api/identity/sign-in", {
      email,
      password: testPassword,
    });
    const result = await decodeApplicationResponse(
      response,
      SignInResponseSchema,
    );
    if (result.status !== "authenticated")
      throw new Error(`Integrated signin failed: ${result.status}`);
    connection.profile = result.user;
    connection.cookie = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    return connection;
  }
  async function verify(email: string) {
    const result = await decodeApplicationResponse(
      await anonymous.request("/api/identity/verify-email", {
        token: mailer.token("verify_email", email),
      }),
      VerifyEmailResponseSchema,
    );
    if (result.status !== "email_verified")
      throw new Error(`Integrated verification failed: ${result.status}`);
  }
  async function bootstrap() {
    const email = "operator@example.invalid";
    const result = await decodeApplicationResponse(
      await anonymous.request("/api/identity/bootstrap", {
        email,
        displayName: "Operator",
        password: testPassword,
        bootstrapSecret: environment.OPERATOR_BOOTSTRAP_SECRET,
      }),
      RegisterAccountResponseSchema,
    );
    if (result.status !== "registered")
      throw new Error(`Integrated bootstrap failed: ${result.status}`);
    await verify(email);
    return signIn(client(), email);
  }
  async function createServer(
    operator: ApplicationClient,
    name = "First server",
    commandId = crypto.randomUUID(),
  ) {
    const response = await operator.request("/api/servers", {
      commandId,
      name,
    });
    const result = await decodeApplicationResponse(
      response,
      ResourceCreatedSchema,
    );
    if (result.kind !== "created")
      throw new Error(`Integrated server creation failed: ${result.kind}`);
    return {
      ...result,
      commandId,
      name,
      path: resourcePath(result.owner),
      response,
    };
  }
  async function invite(
    operator: ApplicationClient,
    serverId: string,
    maxUses = 1,
  ) {
    const result = await decodeApplicationResponse(
      await operator.request(`/api/servers/${serverId}/invites`, {
        expiresAt: Date.now() + 60 * 60_000,
        maxUses,
      }),
      AdministrationOutcomeSchema,
    );
    if (result.kind !== "invite_created")
      throw new Error(`Integrated invitation failed: ${result.kind}`);
    return result;
  }
  async function registerMember(
    operator: ApplicationClient,
    serverId: string,
    email = "alice@example.invalid",
    displayName = "Alice",
  ) {
    const invitation = await invite(operator, serverId);
    const registration = {
      token: invitation.token,
      registrationId: crypto.randomUUID(),
      email,
      displayName,
      password: testPassword,
    };
    const firstResponse = await anonymous.request(
      "/api/invites/register",
      registration,
    );
    const first = await decodeApplicationResponse(
      firstResponse,
      InviteRegistrationResponseSchema,
    );
    if (!("status" in first) || first.status !== "registered")
      throw new Error("Integrated invitation registration failed.");
    await verify(email);
    const member = await signIn(client(), email);
    const joined = await decodeApplicationResponse(
      await member.request("/api/invites/join", { token: invitation.token }),
      AdministrationOutcomeSchema,
    );
    if (joined.kind !== "joined" || joined.serverId !== serverId)
      throw new Error("Integrated invitation redemption failed.");
    // Fixtures that discover this member start after the owner's publication.
    await runDurableObjectAlarm(environment.SERVER_DO.getByName(serverId));
    await expect
      .poll(() =>
        environment.IDENTITY_DB.prepare(
          "SELECT user_id FROM resource_membership_index WHERE resource_id = ? AND user_id = ?",
        )
          .bind(serverId, first.userId)
          .first("user_id"),
      )
      .toBe(first.userId);
    return { member, invitation, registration, registered: first, joined };
  }
  async function twoServers() {
    const operator = await bootstrap();
    const first = await createServer(operator, "First server");
    const second = await createServer(operator, "Second server");
    const alice = await registerMember(operator, first.owner.id);
    const bob = await registerMember(
      operator,
      second.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    return { operator, first, second, alice, bob };
  }
  return {
    environment,
    app,
    mailer,
    anonymous,
    client,
    signIn,
    verify,
    bootstrap,
    createServer,
    invite,
    registerMember,
    twoServers,
  };
}

export async function applicationSocket(response: Response) {
  if (response.status !== 101 || !response.webSocket)
    throw new Error(`Integrated websocket upgrade failed: ${response.status}`);
  const client = response.webSocket;
  const frames: ServerEvent[] = [];
  const queued: ServerEvent[] = [];
  const waiters: {
    resolve: (frame: ServerEvent) => void;
    reject: (error: Error) => void;
  }[] = [];
  let failure: Error | undefined;
  const next = () => {
    if (failure) return Promise.reject(failure);
    const existing = queued.shift();
    return existing
      ? Promise.resolve(existing)
      : new Promise<ServerEvent>((resolve, reject) =>
          waiters.push({ resolve, reject }),
        );
  };
  client.addEventListener("message", (event) => {
    try {
      const frame = ServerEventSchema.parse(JSON.parse(String(event.data)));
      frames.push(frame);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else queued.push(frame);
    } catch {
      failure = new Error(
        "Integrated websocket produced an invalid event contract.",
      );
      for (const waiter of waiters.splice(0)) waiter.reject(failure);
    }
  });
  const readyPromise = next();
  client.accept();
  const ready = await readyPromise;
  if (ready.type !== "ready")
    throw new Error("Integrated websocket did not produce ready.");
  async function close() {
    if (client.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      client.addEventListener("close", () => resolve(), { once: true }),
    );
    client.close(1000);
    await closed;
  }
  return { client, frames, next, ready, close };
}
