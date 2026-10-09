import { readHttpFailure } from "@tests/helpers/http";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { createHttpApp } from "@/server/http";
import type { AuthEnvironment } from "@/server/auth/environment";
import type { IdentityMail, IdentityMailer } from "@/server/auth/mail";
import type { IdentityDependencies } from "@/server/routes/identity";
import {
  RegisterAccountResponseSchema,
  SignInResponseSchema,
} from "@vaskel/contracts/identity";

export class CapturedIdentityMailer implements IdentityMailer {
  readonly messages: IdentityMail[] = [];
  fail = false;
  async send(message: IdentityMail): Promise<void> {
    if (this.fail) throw new Error("Test-only interrupted mail delivery.");
    this.messages.push(message);
  }
  token(kind: "verify_email" | "reset_password", email?: string): string {
    const subject =
      kind === "verify_email"
        ? "Verify your vaskel. email"
        : "Reset your vaskel. password";
    const message = this.messages.findLast(
      (candidate) =>
        candidate.subject === subject && (!email || candidate.to === email),
    );
    const match = message?.text.match(/https:\/\/vaskel\.test\/[^\s]+/);
    if (!match) throw new Error("No captured test mail link.");
    const token = new URL(match[0]).searchParams.get("token");
    if (!token) throw new Error("No captured test mail token.");
    return token;
  }
}

export const testPassword = "correct horse battery staple";
export const replacementPassword = "a different safe passphrase";

export function identityHarness(
  hooks: Omit<IdentityDependencies, "mailer"> = {},
) {
  const mailer = new CapturedIdentityMailer();
  const environment: AuthEnvironment = env;
  const clientAddress = `2001:db8:${crypto.randomUUID().slice(0, 4)}:${crypto.randomUUID().slice(0, 4)}::1`;
  const dependencies = { ...hooks, mailer };
  const app = createHttpApp({ identity: dependencies });
  async function request(
    path: string,
    body?: unknown,
    options: {
      cookie?: string;
      origin?: string | null;
      requestOrigin?: string;
      headers?: HeadersInit;
      environment?: AuthEnvironment;
    } = {},
  ) {
    const requestEnvironment = options.environment ?? environment;
    const requestOrigin =
      options.requestOrigin ?? requestEnvironment.AUTH_ORIGIN;
    const method = body === undefined ? "GET" : "POST";
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set("CF-Connecting-IP", clientAddress);
    if (options.origin !== null)
      headers.set("Origin", options.origin ?? requestOrigin);
    if (options.cookie) headers.set("Cookie", options.cookie);
    new Headers(options.headers).forEach((value, key) =>
      headers.set(key, value),
    );
    const executionContext = createExecutionContext();
    const response = await app.request(
      `${requestOrigin}${path}`,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { ...env, ...requestEnvironment },
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    return response;
  }
  async function bootstrap(email = "operator@example.invalid") {
    const response = await request("/api/identity/bootstrap", {
      email,
      displayName: "Operator",
      password: testPassword,
      bootstrapSecret: environment.OPERATOR_BOOTSTRAP_SECRET,
    });
    const result = RegisterAccountResponseSchema.parse(await response.json());
    if (result.status !== "registered")
      throw new Error(`Test bootstrap failed: ${result.status}`);
    return result;
  }
  async function verify(email = "operator@example.invalid") {
    return request("/api/identity/verify-email", {
      token: mailer.token("verify_email", email),
    });
  }
  async function signIn(
    email = "operator@example.invalid",
    password = testPassword,
  ) {
    const response = await request("/api/identity/sign-in", {
      email,
      password,
    });
    const result = response.ok
      ? SignInResponseSchema.parse(await response.json())
      : await readHttpFailure(response);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { response, result, cookie };
  }
  return {
    environment,
    mailer,
    dependencies,
    app,
    request,
    bootstrap,
    verify,
    signIn,
  };
}
