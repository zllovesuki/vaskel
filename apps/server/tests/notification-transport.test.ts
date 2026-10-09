import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_PROVIDER_LIFETIME_MS,
  NOTIFICATION_WORK_LIFETIME_MS,
  type NotificationPayload,
} from "@vaskel/contracts/notifications";
import {
  createVapidKeys,
  preparePushPayload,
  preparePushRequest,
  validatePushSubscription,
} from "@/server/notifications/web-push";
import {
  decodePushBytes,
  isSupportedPushEndpoint,
} from "@/server/notifications/endpoint";
import {
  consumePushBatch,
  ReadyPushRequestSchema,
  sendPushRequest,
  type ReadyPushRequest,
} from "@/server/notifications/transport";
import {
  decryptPush,
  pushReceiver,
  rfc8291Ciphertext,
  verifyPushAuthorization,
} from "@tests/helpers/push-provider";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const payload: NotificationPayload = {
  accountId: "00000000-0000-4000-8000-000000000001",
  title: "New message",
  body: "A friend wants your attention 👋",
  tag: "room-1",
  owner: null,
  roomId: null,
  messageId: null,
};

async function readyJob(): Promise<ReadyPushRequest> {
  const createdAt = Date.now();
  return {
    ...(await preparePushRequest({
      subscription: pushReceiver,
      payload: await preparePushPayload(payload),
      vapidKeys: await createVapidKeys(),
      subject: "mailto:vaskel@example.invalid",
      expiresAt: createdAt + NOTIFICATION_WORK_LIFETIME_MS,
      providerExpiresAt: createdAt + NOTIFICATION_PROVIDER_LIFETIME_MS,
    })),
    accountId: payload.accountId,
    deviceId: "00000000-0000-4000-8000-000000000002",
    subscriptionVersion: 1,
  };
}

async function consume(
  job: unknown,
  attempts = 1,
  feedback = vi.fn(async () => {}),
) {
  const batch = createMessageBatch("synthetic-push", [
    { id: "job", body: job, attempts, timestamp: Date.now() - 1000 },
  ]);
  const namespace = {
    getByName: vi.fn(() => ({ removeDeadSubscription: feedback })),
  };
  // The pool's getQueueResult omits delaySeconds; observe the native retry call too.
  const retry = vi.spyOn(batch.messages[0]!, "retry");
  // There is deliberately no D1 binding available to the delivery path.
  await consumePushBatch(batch, { NOTIFICATION_DO: namespace });
  return {
    ...(await getQueueResult(batch, createExecutionContext())),
    namespace,
    feedback,
    retries: retry.mock.calls.map(([options]) => options),
  };
}

describe("native Web Push protocol", () => {
  it("checks the independent decryptor against the RFC 8291 published vector", async () => {
    expect(await decryptPush(rfc8291Ciphertext)).toBe(
      "When I grow up, I want to be a watermelon",
    );
  });

  it("prepares interoperable ciphertext and valid per-account VAPID without putting keys in the job", async () => {
    const vapidKeys = await createVapidKeys();
    const request = await preparePushRequest({
      subscription: pushReceiver,
      payload: await preparePushPayload(payload),
      vapidKeys,
      expiresAt: Date.now() + NOTIFICATION_WORK_LIFETIME_MS,
      providerExpiresAt: Date.now() + NOTIFICATION_PROVIDER_LIFETIME_MS,
      subject: "mailto:vaskel@example.invalid",
    });
    expect(
      JSON.parse(await decryptPush(decodePushBytes(request.body))),
    ).toEqual(payload);
    await verifyPushAuthorization(
      request.headers.authorization,
      request.endpoint,
      vapidKeys.publicKey,
    );
    expect(JSON.stringify(request)).not.toContain(vapidKeys.privateKey);
    expect(JSON.stringify(request)).not.toContain(pushReceiver.keys.auth);
    expect(JSON.stringify(request)).not.toContain(payload.body);
    expect(request.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    const second = await createVapidKeys();
    expect(second.publicKey).not.toBe(vapidKeys.publicKey);
    expect(decodePushBytes(request.body).length).toBeLessThan(2744);
  });

  it("bounds multibyte text without changing account, tag or click navigation", async () => {
    const largePayload = {
      ...payload,
      title: "🦊".repeat(125),
      body: "🦊".repeat(300),
      tag: "🦊".repeat(100),
    };
    const request = await preparePushRequest({
      subscription: pushReceiver,
      payload: await preparePushPayload(largePayload),
      vapidKeys: await createVapidKeys(),
      expiresAt: Date.now() + NOTIFICATION_WORK_LIFETIME_MS,
      providerExpiresAt: Date.now() + NOTIFICATION_PROVIDER_LIFETIME_MS,
      subject: "mailto:vaskel@example.invalid",
    });
    const plaintext = await decryptPush(decodePushBytes(request.body));
    expect(new TextEncoder().encode(plaintext).length).toBeLessThanOrEqual(
      2500,
    );
    expect(JSON.parse(plaintext)).toMatchObject({
      accountId: payload.accountId,
      tag: largePayload.tag,
      owner: null,
    });
    expect(plaintext).not.toContain("�");
  });

  it("rejects unsupported endpoints, noncanonical keys and invalid P-256 points", async () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/send",
      "https://127.0.0.1/send",
      "https://fcm.googleapis.com.attacker.test/send",
      "https://evilpush.apple.com/send",
      "https://fcm.googleapis.com:444/send",
      "https://user:pass@fcm.googleapis.com/send",
      "https://fcm.googleapis.com/send#fragment",
      "https://push.example/send",
      "https://fcm.googleapis.com\\@attacker.test/send",
    ]) {
      expect(isSupportedPushEndpoint(endpoint), endpoint).toBe(false);
    }
    for (const endpoint of [
      pushReceiver.endpoint,
      "https://updates.push.services.mozilla.com/wpush/v2/token",
      "https://web.push.apple.com/token",
      "https://wns2-db5p.notify.windows.com/token",
      "https://jmt17.google.com/fcm/send/token",
    ])
      expect(isSupportedPushEndpoint(endpoint)).toBe(true);
    expect(await validatePushSubscription(pushReceiver)).toBe(true);
    expect(
      await validatePushSubscription({
        ...pushReceiver,
        keys: { ...pushReceiver.keys, p256dh: "B" + "A".repeat(86) },
      }),
    ).toBe(false);
    expect(
      await validatePushSubscription({
        ...pushReceiver,
        keys: { ...pushReceiver.keys, auth: pushReceiver.keys.auth + "==" },
      }),
    ).toBe(false);
  });
});

describe("ready request transport", () => {
  it("posts once with manual redirects, compact ciphertext and a decreasing fixed TTL", async () => {
    const job = await readyJob();
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("content-encoding")).toBe("aes128gcm");
      expect(
        JSON.parse(
          await decryptPush(new Uint8Array(await request.arrayBuffer())),
        ),
      ).toEqual(payload);
      return new Response(null, { status: 201 });
    });
    await expect(sendPushRequest(job, 1, fetcher)).resolves.toMatchObject({
      kind: "accepted",
    });
    const firstTtl = Number(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get("ttl"),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(sendPushRequest(job, 2, fetcher)).resolves.toMatchObject({
      kind: "accepted",
    });
    const secondTtl = Number(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get("ttl"),
    );
    expect(firstTtl - secondTtl).toBe(60);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_WORK_LIFETIME_MS);
    await expect(sendPushRequest(job, 3, fetcher)).resolves.toEqual({
      kind: "expired",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("acknowledges expiration, invalid jobs and redirects without account or D1 reads", async () => {
    const job = await readyJob();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test" },
      }),
    );
    expect(ReadyPushRequestSchema.safeParse(job).success).toBe(true);
    for (const input of [
      { ...job, expiresAt: Date.now() - 1 },
      { ...job, providerExpiresAt: Date.now() - 1 },
      { ...job, endpoint: "https://attacker.test" },
      { ...job, headers: { ...job.headers, cookie: "secret" } },
    ]) {
      const result = await consume(input);
      expect(result.explicitAcks).toEqual(["job"]);
      expect(result.namespace.getByName).not.toHaveBeenCalled();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await consume(job)).explicitAcks).toEqual(["job"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries transient responses within the original expiry and attempt limit", async () => {
    const job = await readyJob();
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const status of [408, 429, 500, 503]) {
      fetcher.mockResolvedValue(
        new Response(null, { status, headers: { "retry-after": "12" } }),
      );
      expect((await consume(job)).retries).toEqual([{ delaySeconds: 12 }]);
    }
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    expect((await consume(job, 3)).retries).toEqual([{ delaySeconds: 20 }]);
    expect((await consume(job, 4)).explicitAcks).toEqual(["job"]);
    fetcher.mockResolvedValue(
      new Response(null, { status: 429, headers: { "retry-after": "999999" } }),
    );
    expect((await consume(job)).explicitAcks).toEqual(["job"]);
    fetcher.mockRejectedValue(new Error("sensitive-network-detail"));
    expect((await consume(job)).retries).toEqual([{ delaySeconds: 5 }]);
  });

  it("bounds a stuck provider even if it ignores cancellation", async () => {
    const job = await readyJob();
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const result = sendPushRequest(job, 1, fetcher);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ kind: "retry", delaySeconds: 5 });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("reports only the exact dead subscription and acknowledges failed feedback", async () => {
    const job = await readyJob();
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const status of [404, 410]) {
      fetcher.mockResolvedValue(new Response(null, { status }));
      const result = await consume(job);
      expect(result.namespace.getByName).toHaveBeenCalledExactlyOnceWith(
        job.accountId,
      );
      expect(result.feedback).toHaveBeenCalledExactlyOnceWith(
        job.deviceId,
        job.subscriptionVersion,
        job.endpoint,
      );
      expect(result.explicitAcks).toEqual(["job"]);
    }
    const failing = vi.fn(async () => {
      throw new Error("feedback unavailable");
    });
    expect((await consume(job, 1, failing)).explicitAcks).toEqual(["job"]);
  });

  it("permits duplicate deliveries, never logging endpoints, ciphertext or provider bodies", async () => {
    const job = await readyJob();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("provider-secret-body", { status: 201 }),
      );
    await consume(job);
    await consume(job);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(job.endpoint);
    expect(logged).not.toContain(job.body);
    expect(logged).not.toContain(job.headers.authorization);
    expect(logged).not.toContain("provider-secret-body");
    expect(logged).toContain("queueAgeMs");
  });
});
