export type AuthEnvironment = Pick<
  Env,
  | "IDENTITY_DB"
  | "EVENT_DISPATCH"
  | "AUTH_ORIGIN"
  | "AUTH_SECRET"
  | "OPERATOR_BOOTSTRAP_SECRET"
  | "OPERATOR_BOOTSTRAP_EXPIRES_AT"
  | "EMAIL"
  | "MAIL_FROM"
  | "AUTH_RATE_LIMITER"
  | "SENSITIVE_RATE_LIMITER"
  | "INSTANCE_ACCOUNT_LIMIT"
>;

const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];

export function authOrigin(env: AuthEnvironment): string | null {
  try {
    const url = new URL(env.AUTH_ORIGIN);
    const local = loopbackHosts.includes(url.hostname);
    if (url.origin !== env.AUTH_ORIGIN || url.username || url.password)
      return null;
    if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function trustedAuthOrigins(env: AuthEnvironment): string[] {
  const origin = authOrigin(env);
  if (!origin) return [];
  const url = new URL(origin);
  if (url.protocol !== "http:") return [origin];
  // HTTP is configured only for loopback; aliases keep the configured port.
  return loopbackHosts.map((hostname) => {
    url.hostname = hostname;
    return url.origin;
  });
}

export function authConfigured(env: AuthEnvironment): boolean {
  return (
    authOrigin(env) !== null &&
    typeof env.AUTH_SECRET === "string" &&
    env.AUTH_SECRET.length >= 32
  );
}

export function requestOriginAllowed(
  request: Request,
  env: AuthEnvironment,
): boolean {
  const origin = new URL(request.url).origin;
  if (!trustedAuthOrigins(env).includes(origin)) return false;
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const supplied = request.headers.get("Origin");
  if (request.method !== "GET" && request.method !== "HEAD")
    return supplied === origin;
  return supplied === null || supplied === origin;
}
