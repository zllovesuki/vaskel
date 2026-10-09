import { sign, verify } from "hono/jwt";
import { z } from "zod";
import {
  ATTACHMENT_BYTE_LIMIT,
  AttachmentFilenameSchema,
} from "@vaskel/contracts/attachments";
import type { AttachmentDownload } from "@/server/actors/shared/attachments/types";
import { privateFingerprint } from "@/server/auth/crypto";

export const ATTACHMENT_GRANT_MS = 60 * 60_000;
const GRANT_AUDIENCE = "vaskel:attachment";
const GRANT_ALGORITHM = "HS256";

/**
 * Signed, non-secret metadata of one immutable file. Serving checks object
 * integrity against it without a directory lookup or an actor call, and the
 * token is bearer access until its fixed expiry.
 */
const GrantClaimsSchema = z.strictObject({
  aud: z.literal(GRANT_AUDIENCE),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  fileId: z.uuid(),
  key: z.string().min(1),
  etag: z.string().min(1),
  version: z.string().min(1),
  byteLength: z.number().int().min(1).max(ATTACHMENT_BYTE_LIMIT),
  filename: AttachmentFilenameSchema,
});
export type GrantClaims = z.infer<typeof GrantClaimsSchema>;

type GrantEnvironment = Pick<Env, "AUTH_SECRET">;

/** An attachment-specific key derived from the instance secret; the secret itself never signs. */
function grantKey(env: GrantEnvironment): Promise<string> {
  return privateFingerprint(env.AUTH_SECRET, "attachment-grant");
}

export async function mintAttachmentGrant(
  env: GrantEnvironment,
  download: AttachmentDownload,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + ATTACHMENT_GRANT_MS / 1000;
  const claims: GrantClaims = {
    aud: GRANT_AUDIENCE,
    iat: issuedAt,
    exp: expiresAt,
    fileId: download.fileId,
    key: download.objectKey,
    etag: download.etag,
    version: download.version,
    byteLength: download.byteLength,
    filename: download.filename,
  };
  return {
    token: await sign(claims, await grantKey(env), GRANT_ALGORITHM),
    expiresAt: expiresAt * 1000,
  };
}

/** The signature, the fixed algorithm, the audience, an expiry and the file scope are all required. */
export async function verifyAttachmentGrant(
  env: GrantEnvironment,
  token: string,
): Promise<GrantClaims | null> {
  let payload: unknown;
  try {
    payload = await verify(token, await grantKey(env), {
      alg: GRANT_ALGORITHM,
      aud: GRANT_AUDIENCE,
    });
  } catch {
    return null;
  }
  const claims = GrantClaimsSchema.safeParse(payload);
  return claims.success ? claims.data : null;
}
