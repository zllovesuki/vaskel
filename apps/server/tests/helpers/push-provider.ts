import { expect } from "vitest";

// Public RFC 8291 section 5 receiver key material, never a real subscription.
export const pushReceiver = {
  endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-subscription",
  keys: {
    p256dh:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};
const receiverPrivate = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hkdf(
  input: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bits: number,
) {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bits,
    ),
  );
}

/** Independent RFC 8291 decryptor uses native HKDF, not the producer library. */
export async function decryptPush(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  expect(bytes[20]).toBe(65);
  expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16)).toBe(4096);
  const receiverPublic = decode(pushReceiver.keys.p256dh);
  const receiverKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: encode(receiverPublic.slice(1, 33)),
      y: encode(receiverPublic.slice(33)),
      d: receiverPrivate,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const senderPublic = bytes.slice(21, 86);
  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const agreement = { name: "ECDH", public: senderKey };
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(agreement, receiverKey, 256),
  );
  const encoder = new TextEncoder();
  const keyInfo = new Uint8Array([
    ...encoder.encode("WebPush: info\0"),
    ...receiverPublic,
    ...senderPublic,
  ]);
  const ikm = await hkdf(shared, decode(pushReceiver.keys.auth), keyInfo, 256);
  const cek = await hkdf(
    ikm,
    bytes.slice(0, 16),
    new Uint8Array(encoder.encode("Content-Encoding: aes128gcm\0")),
    128,
  );
  const nonce = await hkdf(
    ikm,
    bytes.slice(0, 16),
    new Uint8Array(encoder.encode("Content-Encoding: nonce\0")),
    96,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      bytes.slice(86),
    ),
  );
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return new TextDecoder().decode(padded.slice(0, end));
}

export async function verifyPushAuthorization(
  header: string,
  endpoint: string,
  expectedPublicKey: string,
) {
  const match = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
  expect(match).not.toBeNull();
  const [, jwt, publicKey] = match!;
  expect(publicKey).toBe(expectedPublicKey);
  const [encodedHeader, encodedPayload, signature] = jwt!.split(".");
  expect(JSON.parse(new TextDecoder().decode(decode(encodedHeader!)))).toEqual({
    alg: "ES256",
    typ: "JWT",
  });
  const claims = JSON.parse(
    new TextDecoder().decode(decode(encodedPayload!)),
  ) as { aud: string; sub: string; exp: number };
  expect(claims.aud).toBe(new URL(endpoint).origin);
  expect(claims.sub).toBe("mailto:vaskel@example.invalid");
  expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  expect(claims.exp).toBeLessThanOrEqual(
    Math.floor(Date.now() / 1000) + 24 * 60 * 60,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    decode(publicKey!),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decode(signature!),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    ),
  ).toBe(true);
}

export const rfc8291Ciphertext = decode(
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
);
