import { INSTANCE_ICON_BYTE_LIMIT } from "@vaskel/contracts/instance";
import { sql } from "kysely";
import { identityDatabase } from "@/server/auth/database";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { instanceSettings, instanceView } from "./settings";
import { liveOperator } from "@/server/auth/sql-authority";

const prefix = "instance-icons/";
const publicationMs = 5 * 60_000;
const cleanupAgeMs = 10 * 60_000;

function rasterType(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
    new TextDecoder().decode(bytes.subarray(12, 16)) === "IHDR"
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    return "image/jpeg";
  if (
    bytes.length >= 16 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(
      new TextDecoder().decode(bytes.subarray(12, 16)),
    )
  )
    return "image/webp";
  return null;
}

export async function uploadInstanceIcon(
  env: Env,
  principal: IdentityPrincipal,
  request: Request,
) {
  // Ingress bodyLimit bounds the stream before this small, purpose-specific buffer.
  const bytes = new Uint8Array(await request.arrayBuffer());
  const contentType = rasterType(bytes);
  if (
    bytes.length > INSTANCE_ICON_BYTE_LIMIT ||
    !contentType ||
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      contentType
  )
    return { kind: "invalid_input" as const };
  const issuedAt = Date.now();
  const key = `${prefix}${issuedAt}/${crypto.randomUUID()}`;
  await env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType } });
  // The D1 write rechecks the session and operator capability
  // after R2 settles. Unpublished bytes remain private and are swept durably.
  if (Date.now() > issuedAt + publicationMs)
    return { kind: "forbidden" as const };
  const result = await identityDatabase(env)
    .updateTable("instance_settings")
    .set({ icon_key: key, icon_type: contentType, updated_at: Date.now() })
    .where("id", "=", 1)
    .where(liveOperator(principal))
    .where(
      sql<boolean>`${issuedAt + publicationMs} >= CAST(strftime('%s', 'now') AS INTEGER) * 1000`,
    )
    .returning("id")
    .execute();
  return result.length ? instanceView(env) : { kind: "forbidden" as const };
}

export async function downloadInstanceIcon(env: Env) {
  const settings = await instanceSettings(env);
  if (!settings.icon_key || !settings.icon_type)
    return new Response(null, { status: 404 });
  const object = await env.ATTACHMENTS.get(settings.icon_key);
  if (!object || object.size > INSTANCE_ICON_BYTE_LIMIT)
    return new Response(null, { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": settings.icon_type,
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/** One bounded page per scheduled tick; retries and late puts are found on subsequent sweeps. */
export async function cleanupInstanceIcons(env: Env, now = Date.now()) {
  const db = identityDatabase(env);
  const cursor = (
    await db
      .selectFrom("instance_settings")
      .select("icon_cleanup_cursor")
      .where("id", "=", 1)
      .executeTakeFirst()
  )?.icon_cleanup_cursor;
  const page = await env.ATTACHMENTS.list({
    prefix,
    limit: 50,
    ...(cursor ? { cursor } : {}),
  });
  const current = await instanceSettings(env);
  const expired = page.objects.filter((object) => {
    const issuedAt = Number(object.key.slice(prefix.length).split("/")[0]);
    return (
      object.key !== current.icon_key &&
      Number.isSafeInteger(issuedAt) &&
      issuedAt + cleanupAgeMs < now
    );
  });
  if (expired.length)
    await env.ATTACHMENTS.delete(expired.map((object) => object.key));
  const nextCursor = page.truncated ? page.cursor : null;
  await db
    .updateTable("instance_settings")
    .set({ icon_cleanup_cursor: nextCursor })
    .where("id", "=", 1)
    .where("icon_cleanup_cursor", "is not", nextCursor)
    .execute();
  return expired.length;
}
