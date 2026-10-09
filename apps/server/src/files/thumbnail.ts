import {
  ATTACHMENT_BYTE_LIMIT,
  detectInlineContentType,
  INLINE_SIGNATURE_BYTES,
} from "@vaskel/contracts/attachments";
import { outcomeResponse } from "@/server/http/orpc";
import { logEvent } from "@/server/telemetry";
import { etagMatches } from "./download";
import type { GrantClaims } from "./grant";
import {
  ThumbnailError,
  type ThumbnailFailureReason,
} from "./thumbnail/errors";

/** The source identity and renderer revision identify this PNG representation. */
const THUMBNAIL_REVISION = "thumbnail-1";
const MAX_READS = 128;
const MAX_READ_BYTES = 2 * ATTACHMENT_BYTE_LIMIT;
const READ_CHUNK_BYTES = 32 * 1_024;
const CACHE_SECONDS = 300;

function cacheControl(expiresAt: number) {
  const seconds = Math.max(
    0,
    Math.min(CACHE_SECONDS, expiresAt - Math.ceil(Date.now() / 1_000)),
  );
  return seconds > 0
    ? `private, max-age=${seconds}, must-revalidate`
    : "private, no-store";
}

/** Called only after grant verification; transformed bytes inherit the grant's lifetime. */
export async function serveThumbnail(
  request: Request,
  bucket: Pick<R2Bucket, "get">,
  grant: GrantClaims,
): Promise<Response> {
  const etag = `${THUMBNAIL_REVISION}-${grant.version}-${grant.etag}`;
  const headers = new Headers({
    ETag: `"${etag}"`,
    "Content-Type": "image/png",
    "X-Content-Type-Options": "nosniff",
  });
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    headers.set("Cache-Control", cacheControl(grant.exp));
    return new Response(null, { status: 304, headers });
  }

  let reads = 0;
  let readBytes = 0;
  let requestedBytes = 0;
  const started = performance.now();
  let status = 404;
  let outputBytes: number | undefined;
  let wasmMemoryBytes: number | undefined;
  let failureReason: ThumbnailFailureReason | undefined;
  let storageFailure: { error: unknown } | undefined;
  // Keep the beginning available while the demuxer visits metadata at the end.
  const chunks: { start: number; bytes: Uint8Array }[] = [];
  const read = async (start: number, end: number) => {
    if (request.signal.aborted) throw new ThumbnailError("cancelled");
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > grant.byteLength
    )
      throw new ThumbnailError("read_limit");
    const cached = chunks.find(
      (chunk) =>
        start >= chunk.start && end <= chunk.start + chunk.bytes.length,
    );
    // The demuxer's own cache must not retain evicted read-ahead buffers.
    if (cached)
      return cached.bytes.slice(start - cached.start, end - cached.start);

    const small = end - start <= READ_CHUNK_BYTES;
    const readEnd = small
      ? Math.min(grant.byteLength, start + READ_CHUNK_BYTES)
      : end;
    const length = readEnd - start;
    // Limits and telemetry count actual R2 reads, including read-ahead bytes.
    if (reads >= MAX_READS || requestedBytes + length > MAX_READ_BYTES)
      throw new ThumbnailError("read_limit");
    reads++;
    requestedBytes += length;
    let object;
    try {
      object = await bucket.get(grant.key, {
        range: { offset: start, length },
        onlyIf: { etagMatches: grant.etag },
      });
    } catch (error) {
      storageFailure = { error };
      throw error;
    }
    if (!object || !("body" in object))
      throw new ThumbnailError("source_unavailable");
    if (object.version !== grant.version || object.size !== grant.byteLength) {
      await object.body.cancel();
      throw new ThumbnailError("source_unavailable");
    }
    const bytes = await object.bytes().catch((error: unknown) => {
      storageFailure = { error };
      throw error;
    });
    readBytes += bytes.byteLength;
    if (bytes.byteLength !== length)
      throw new ThumbnailError("source_unavailable");
    // A known large range stays one GET and does not displace the small chunks.
    if (small) {
      chunks.push({ start, bytes });
      if (chunks.length > 2) chunks.shift();
      return bytes.slice(0, end - start);
    }
    return bytes;
  };
  try {
    const leading = await read(
      0,
      Math.min(INLINE_SIGNATURE_BYTES, grant.byteLength),
    );
    if (!detectInlineContentType(leading)?.startsWith("video/"))
      throw new ThumbnailError("unsupported_format");
    // Vite keeps the demuxer, PNG encoder and WASM behind this import.
    // A 304, invalid grant or non-video never starts the decoder.
    const { generateThumbnail } = await import("./thumbnail/generate");
    const result = await generateThumbnail(grant.byteLength, read);
    const { bytes } = result;
    status = 200;
    outputBytes = bytes.byteLength;
    wasmMemoryBytes = result.wasmMemoryBytes;
    headers.set("Cache-Control", cacheControl(grant.exp));
    headers.set("Content-Length", String(bytes.byteLength));
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  } catch (error) {
    if (storageFailure) {
      status = 500;
      failureReason = "storage_failed";
      throw storageFailure.error;
    }
    failureReason = request.signal.aborted
      ? "cancelled"
      : error instanceof ThumbnailError
        ? error.reason
        : "internal_error";
    // A preview is optional: unsupported or damaged media keeps the file controls.
    const response = outcomeResponse({ kind: "not_found" });
    if (
      failureReason === "unsupported_codec" ||
      failureReason === "unsupported_format"
    )
      response.headers.set("Cache-Control", cacheControl(grant.exp));
    return response;
  } finally {
    logEvent("log", "attachment_thumbnail", {
      status,
      ...(failureReason === undefined ? {} : { failureReason }),
      durationMs: performance.now() - started,
      sourceBytes: grant.byteLength,
      readBytes,
      readCalls: reads,
      ...(outputBytes === undefined ? {} : { outputBytes }),
      ...(wasmMemoryBytes === undefined ? {} : { wasmMemoryBytes }),
    });
  }
}
