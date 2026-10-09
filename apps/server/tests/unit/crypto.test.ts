import { describe, expect, it } from "vitest";
import {
  base64url,
  privateFingerprint,
  randomIdentityToken,
  sha256Hex,
} from "@/server/auth/crypto";
import { payloadHash, stableId } from "@/server/directory/identifiers";

/** Stored receipts, identifiers and tokens depend on these exact forms. */
describe("digest and encoding representations", () => {
  it("hashes a plain string to lowercase hex SHA-256", async () => {
    const abc =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(abc);
  });

  it("derives stable identifiers as truncated UUIDv8 digests", async () => {
    expect(await stableId("direct-conversation", "alice", "bob")).toBe(
      "c82a4c49-2799-82b0-b850-d86ce8993347",
    );
  });

  it("fingerprints payloads through their JSON serialization", async () => {
    expect(await payloadHash({ a: 1, b: [2, null] })).toBe(
      "cc243773f70c3dff1b2058928d222d7edc29130da3f617c0e8ce04096aca153c",
    );
  });

  it("uses stable hex HMAC fingerprints", async () => {
    expect(await privateFingerprint("secret-key", "value")).toBe(
      "dcf95b191d58b2bc62550ecbe2e533583d51df14bc932edf1fe4fb28393c607c",
    );
  });

  it("encodes base64url without padding and issues 32-byte identity tokens", () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xbf, 0x00]))).toBe("-_-_AA");
    expect(randomIdentityToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
