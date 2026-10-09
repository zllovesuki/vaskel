type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const encoder = new TextEncoder();

/** Stored digests, tokens, receipts and cursors all start from these forms. */
export async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function sha256Hex(value: string): Promise<string> {
  return sha256(value).then(hex);
}

/** Unpadded URL-safe alphabet; decoders check the canonical form themselves. */
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Each caller prefixes its own domain, so one key import serves them all. */
export function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmac(
  key: CryptoKey,
  value: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

export function randomIdentityToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function privateFingerprint(
  secret: string,
  value: string,
): Promise<string> {
  return hex(await hmac(await hmacKey(secret), value));
}
