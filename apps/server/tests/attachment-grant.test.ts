import { decode, sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { base64url, privateFingerprint } from "@/server/auth/crypto";
import {
  ATTACHMENT_GRANT_MS,
  mintAttachmentGrant,
  verifyAttachmentGrant,
} from "@/server/files/grant";

const env = { AUTH_SECRET: "unit-test-instance-secret-with-thirty-two-plus" };
const download = {
  fileId: "00000000-0000-4000-8000-000000000001",
  objectKey: "attachments/private-key",
  generation: "generation-1",
  version: "version-1",
  etag: "etag-1",
  byteLength: 10,
  filename: "日本語 資料.txt",
  messageId: "message-1",
};
const encode = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

describe("attachment grants", () => {
  it("round-trips the file metadata under a fixed expiry and the fixed algorithm", async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const grant = await mintAttachmentGrant(env, download, now);
    expect(grant.expiresAt).toBe(now + ATTACHMENT_GRANT_MS);
    expect(decode(grant.token).header).toMatchObject({ alg: "HS256" });
    expect(await verifyAttachmentGrant(env, grant.token)).toEqual({
      aud: "vaskel:attachment",
      iat: now / 1000,
      exp: grant.expiresAt / 1000,
      fileId: download.fileId,
      key: download.objectKey,
      etag: download.etag,
      version: download.version,
      byteLength: download.byteLength,
      filename: download.filename,
    });
  });

  it("refuses expiry, audience, key, algorithm and payload deviations", async () => {
    const key = await privateFingerprint(env.AUTH_SECRET, "attachment-grant");
    const valid = await mintAttachmentGrant(env, download);
    const claims = decode(valid.token).payload as Record<string, unknown>;
    const expired = await mintAttachmentGrant(
      env,
      download,
      Date.now() - ATTACHMENT_GRANT_MS - 1_000,
    );
    expect(await verifyAttachmentGrant(env, expired.token)).toBeNull();
    const { exp: _exp, ...withoutExpiry } = claims;
    expect(
      await verifyAttachmentGrant(env, await sign(withoutExpiry, key, "HS256")),
    ).toBeNull();
    expect(
      await verifyAttachmentGrant(
        env,
        await sign({ ...claims, aud: "vaskel:other" }, key, "HS256"),
      ),
    ).toBeNull();
    const foreign = await mintAttachmentGrant(
      { AUTH_SECRET: "another-instance-secret-with-thirty-two-plus" },
      download,
    );
    expect(await verifyAttachmentGrant(env, foreign.token)).toBeNull();
    expect(
      await verifyAttachmentGrant(env, await sign(claims, key, "HS512")),
    ).toBeNull();
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
    expect(await verifyAttachmentGrant(env, unsigned)).toBeNull();
    const [header, , signature] = valid.token.split(".");
    const tampered = `${header}.${encode({ ...claims, byteLength: 11 })}.${signature}`;
    expect(await verifyAttachmentGrant(env, tampered)).toBeNull();
    const { fileId: _fileId, ...unscoped } = claims;
    expect(
      await verifyAttachmentGrant(env, await sign(unscoped, key, "HS256")),
    ).toBeNull();
  });
});
