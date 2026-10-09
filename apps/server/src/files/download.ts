import {
  type AttachmentOutcome,
  detectInlineContentType,
  INLINE_SIGNATURE_BYTES,
} from "@vaskel/contracts/attachments";
import { outcomeResponse } from "@/server/http/orpc";
import type { GrantClaims } from "./grant";

type ByteRange = { offset: number; length: number };
function failure(outcome: AttachmentOutcome): Response {
  return outcomeResponse(outcome);
}
function disposition(kind: "inline" | "attachment", filename: string): string {
  // ASCII fallback has no paths, control characters, quotes or header syntax.
  const fallback =
    filename.replace(/[^\x20-\x7e]|["\\/;]/g, "_").slice(0, 180) ||
    "attachment";
  const encoded = encodeURIComponent(
    new TextDecoder().decode(new TextEncoder().encode(filename)),
  ).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
/** One `bytes=a-b`, `a-` or `-n` range; anything else serves the whole file. */
function byteRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(first);
  if (offset >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return end < offset ? null : { offset, length: end - offset + 1 };
}
export function etagMatches(header: string | null, etag: string): boolean {
  return (
    header !== null &&
    header
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
      .some((tag) => tag === "*" || tag === etag)
  );
}
/** A client-supplied validator is honoured: only an exact strong match keeps the range. */
function ifRangeAllows(header: string | null, etag: string): boolean {
  return header === null || header.trim() === `"${etag}"`;
}

/**
 * Serves one granted file from the bucket. The grant already carries the
 * object's identity, so integrity is a conditional read against it; the
 * leading bytes alone decide whether the type may display inline.
 */
export async function serveAttachment(
  request: Request,
  bucket: {
    get(
      key: string,
      options: R2GetOptions,
    ): Promise<R2ObjectBody | R2Object | null>;
  },
  grant: GrantClaims,
): Promise<Response> {
  const head = request.method === "HEAD";
  const { etag, byteLength: size } = grant;
  const headers = new Headers({
    ETag: `"${etag}"`,
    "Cache-Control": "private, no-cache",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  if (etagMatches(request.headers.get("If-None-Match"), etag))
    return new Response(null, { status: 304, headers });
  const onlyIf = { etagMatches: etag };
  const leading = await bucket.get(grant.key, {
    range: { offset: 0, length: Math.min(INLINE_SIGNATURE_BYTES, size) },
    onlyIf,
  });
  if (!leading || !("body" in leading)) return failure({ kind: "not_found" });
  const signature = await leading.bytes();
  if (leading.version !== grant.version || leading.size !== size)
    return failure({ kind: "integrity_mismatch" });
  const type = detectInlineContentType(signature);
  headers.set("Content-Type", type ?? "application/octet-stream");
  headers.set(
    "Content-Disposition",
    disposition(type ? "inline" : "attachment", grant.filename),
  );
  // HEAD reports the whole representation; a mismatched If-Range serves it too.
  const range =
    !head && ifRangeAllows(request.headers.get("If-Range"), etag)
      ? byteRange(request.headers.get("Range"), size)
      : null;
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
    );
    headers.set("Content-Length", String(range.length));
  } else headers.set("Content-Length", String(size));
  if (head) return new Response(null, { status: 200, headers });
  const object = await bucket.get(grant.key, {
    onlyIf,
    ...(range ? { range } : {}),
  });
  const body =
    object && "body" in object && object.body instanceof ReadableStream
      ? object.body
      : undefined;
  if (!body) return failure({ kind: "not_found" });
  return new Response(body, { status: range ? 206 : 200, headers });
}
