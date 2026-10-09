import { z } from "zod";
import { logEvent } from "@/server/telemetry";
import { decodePushBytes, isSupportedPushEndpoint } from "./endpoint";

/** Secret-bearing internal transport data; never expose it as a browser contract. */
export const ReadyPushRequestSchema = z.strictObject({
  accountId: z.uuid(),
  deviceId: z.uuid(),
  subscriptionVersion: z.number().int().positive(),
  endpoint: z.string().max(2048).refine(isSupportedPushEndpoint),
  headers: z.strictObject({
    authorization: z
      .string()
      .max(2048)
      .regex(/^vapid t=[A-Za-z0-9_.-]+, k=[A-Za-z0-9_-]+$/u),
    "content-encoding": z.literal("aes128gcm"),
    "content-type": z.literal("application/octet-stream"),
    urgency: z.literal("normal"),
    topic: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  }),
  body: z
    .string()
    .min(138)
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+$/u),
  expiresAt: z.number().int().nonnegative(),
  providerExpiresAt: z.number().int().nonnegative(),
});
export type ReadyPushRequest = z.infer<typeof ReadyPushRequestSchema>;

const MAX_ATTEMPTS = 4;
const PROVIDER_TIMEOUT_MS = 10_000;
const FEEDBACK_TIMEOUT_MS = 2_000;

type ProviderResult = (
  | { kind: "accepted" | "dead" | "rejected" | "expired" }
  | { kind: "retry"; delaySeconds: number }
) & { providerStatus?: number };

function retryDelay(
  value: string | null,
  attempt: number,
  now: number,
): number {
  const fallback = Math.min(300, 5 * 2 ** Math.min(attempt - 1, 6));
  if (!value) return fallback;
  const seconds = /^\d+$/u.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : fallback;
}

/** Execute a prepared request without fetching account, session or message state. */
export async function sendPushRequest(
  job: ReadyPushRequest,
  attempt: number,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ProviderResult> {
  const now = Date.now();
  const ttl = Math.floor((job.providerExpiresAt - now) / 1000);
  if (job.expiresAt <= now || ttl <= 0) return { kind: "expired" };
  if (!isSupportedPushEndpoint(job.endpoint)) return { kind: "rejected" };
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = decodePushBytes(job.body);
  } catch {
    return { kind: "rejected" };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const request = (async (): Promise<ProviderResult> => {
    const response = await fetcher(job.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { ...job.headers, ttl: String(ttl) },
      body,
    });
    // Bodies may contain endpoints, tokens or arbitrary provider text. Never read them.
    void response.body?.cancel().catch(() => {});
    if (finished) return { kind: "expired" };
    if (response.status >= 200 && response.status < 300)
      return { kind: "accepted", providerStatus: response.status };
    if (response.status === 404 || response.status === 410)
      return { kind: "dead", providerStatus: response.status };
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    )
      return {
        kind: "retry",
        providerStatus: response.status,
        delaySeconds: retryDelay(
          response.headers.get("retry-after"),
          attempt,
          Date.now(),
        ),
      };
    return { kind: "rejected", providerStatus: response.status };
  })();
  try {
    return await Promise.race([
      request,
      new Promise<ProviderResult>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve({
              kind: "retry",
              delaySeconds: retryDelay(null, attempt, Date.now()),
            });
          },
          Math.min(PROVIDER_TIMEOUT_MS, job.expiresAt - now),
        );
      }),
    ]);
  } catch {
    return {
      kind: "retry",
      delaySeconds: retryDelay(null, attempt, Date.now()),
    };
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export async function consumePushBatch(
  batch: MessageBatch<unknown>,
  env: {
    NOTIFICATION_DO: {
      getByName(accountId: string): {
        removeDeadSubscription(
          deviceId: string,
          version: number,
          endpoint: string,
        ): Promise<unknown>;
      };
    };
  },
): Promise<void> {
  // Bound external requests independently of the configured batch size.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, batch.messages.length) }, async () => {
      while (next < batch.messages.length) {
        const message = batch.messages[next++]!;
        const parsed = ReadyPushRequestSchema.safeParse(message.body);
        if (!parsed.success || message.attempts > MAX_ATTEMPTS) {
          logEvent("warn", "notification_transport_failed", {
            processed: 1,
            failed: 1,
            attempts: message.attempts,
          });
          message.ack();
          continue;
        }
        const job = parsed.data;
        const started = Date.now();
        const result = await sendPushRequest(job, message.attempts);
        logEvent(
          result.kind === "accepted" || result.kind === "expired"
            ? "log"
            : "warn",
          "notification_transport",
          {
            processed: 1,
            sent: result.kind === "accepted" ? 1 : 0,
            suppressed: result.kind === "expired" ? 1 : 0,
            failed:
              result.kind === "accepted" || result.kind === "expired" ? 0 : 1,
            providerStatus: result.providerStatus,
            queueAgeMs: Math.max(0, started - message.timestamp.getTime()),
            attempts: message.attempts,
            durationMs: Date.now() - started,
          },
        );
        if (result.kind === "dead") {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              env.NOTIFICATION_DO.getByName(
                job.accountId,
              ).removeDeadSubscription(
                job.deviceId,
                job.subscriptionVersion,
                job.endpoint,
              ),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Push feedback deadline")),
                  FEEDBACK_TIMEOUT_MS,
                );
              }),
            ]);
          } catch {
            // Lost feedback leaves a removable stale device, not a recovery obligation.
            logEvent("warn", "notification_endpoint_feedback_failed", {
              failed: 1,
            });
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
        if (
          result.kind === "retry" &&
          message.attempts < MAX_ATTEMPTS &&
          Date.now() + result.delaySeconds * 1000 <
            Math.min(job.expiresAt, job.providerExpiresAt)
        )
          message.retry({ delaySeconds: result.delaySeconds });
        else message.ack();
      }
    }),
  );
}
