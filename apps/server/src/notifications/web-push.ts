import { encryptNotification, vapidHeaders } from "@block65/webcrypto-web-push";
import type {
  NotificationPayload,
  PushSubscription,
} from "@vaskel/contracts/notifications";
import { base64url, sha256 } from "@/server/auth/crypto";
import type { ReadyPushRequest } from "./transport";

export { validatePushSubscription } from "./endpoint";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PreparedPushPayload {
  bytes: Uint8Array<ArrayBuffer>;
  topic: string;
}

export async function createVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pair)) throw new Error("Invalid VAPID key pair");
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (
    !(publicKey instanceof ArrayBuffer) ||
    !("d" in privateKey) ||
    !privateKey.d
  )
    throw new Error("Invalid VAPID key export");
  return {
    publicKey: base64url(new Uint8Array(publicKey)),
    privateKey: privateKey.d,
  };
}

function encodePayload(payload: NotificationPayload): Uint8Array<ArrayBuffer> {
  const bounded = { ...payload };
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(bounded));
  // Leave room for RFC 8188 framing and Android push bridge encapsulation.
  // Trim visible text at code point boundaries; keep navigation and tag intact.
  for (const field of ["body", "title"] as const) {
    const text = Array.from(bounded[field]);
    while (bytes.length > 2500 && text.length > 0) {
      text.pop();
      bounded[field] = text.join("");
      bytes = encoder.encode(JSON.stringify(bounded));
    }
  }
  if (bytes.length > 2500) throw new Error("Push payload exceeds byte limit");
  return new Uint8Array(bytes);
}

/** Shared plaintext and provider Topic; ciphertext remains specific to each device. */
export async function preparePushPayload(
  payload: NotificationPayload,
): Promise<PreparedPushPayload> {
  return {
    bytes: encodePayload(payload),
    topic: base64url((await sha256(payload.tag)).slice(0, 24)),
  };
}

/** Subscriptions have already passed enrollment validation. */
export async function preparePushRequest(input: {
  subscription: PushSubscription;
  payload: PreparedPushPayload;
  vapidKeys: VapidKeys;
  expiresAt: number;
  providerExpiresAt: number;
  subject: string;
}): Promise<
  Omit<ReadyPushRequest, "accountId" | "deviceId" | "subscriptionVersion">
> {
  const subject = new URL(input.subject);
  if (subject.protocol !== "https:" && subject.protocol !== "mailto:")
    throw new Error("Invalid VAPID subject");
  const subscription = { ...input.subscription, expirationTime: null };
  const [authorization, ciphertext] = await Promise.all([
    vapidHeaders(subscription, { ...input.vapidKeys, subject: input.subject }),
    encryptNotification(subscription, input.payload.bytes, {
      pad: false,
    }),
  ]);
  return {
    endpoint: input.subscription.endpoint,
    headers: {
      authorization: authorization.headers.authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      urgency: "normal",
      topic: input.payload.topic,
    },
    body: base64url(ciphertext),
    expiresAt: input.expiresAt,
    providerExpiresAt: input.providerExpiresAt,
  };
}
