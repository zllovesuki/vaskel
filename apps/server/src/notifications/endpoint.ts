import type { PushSubscription } from "@vaskel/contracts/notifications";
import { base64url } from "@/server/auth/crypto";

const exactHosts = new Set([
  "fcm.googleapis.com",
  "jmt17.google.com",
  "updates.push.services.mozilla.com",
]);

/** Push service hosts are the SSRF boundary; redirects never extend it. */
export function isSupportedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048 || /[\s\\]/u.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      (exactHosts.has(url.hostname) ||
        url.hostname.endsWith(".push.apple.com") ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}

export function decodePushBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error("Invalid push encoding");
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw new Error("Invalid push encoding");
  return bytes;
}

export async function validatePushSubscription(
  subscription: PushSubscription,
): Promise<boolean> {
  if (!isSupportedPushEndpoint(subscription.endpoint)) return false;
  try {
    const publicKey = decodePushBytes(subscription.keys.p256dh);
    const auth = decodePushBytes(subscription.keys.auth);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16)
      return false;
    await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return true;
  } catch {
    return false;
  }
}
