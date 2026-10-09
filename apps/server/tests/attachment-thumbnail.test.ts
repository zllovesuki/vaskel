import { env } from "cloudflare:workers";
import { decode } from "fast-png";
import { decodeFrame } from "ffmpeg-tiny";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileGrantPath, fileThumbnailPath } from "@vaskel/contracts/api";
import { createHttpApp } from "@/server/http";
import {
  mintAttachmentGrant,
  verifyAttachmentGrant,
  ATTACHMENT_GRANT_MS,
} from "@/server/files/grant";
import { serveThumbnail } from "@/server/files/thumbnail";
import webm from "./fixtures/thumbnail.webm.bin";
import mp4 from "./fixtures/thumbnail.mp4.bin";
import pq from "./fixtures/thumbnail-pq.mp4.bin";
import hlg from "./fixtures/thumbnail-hlg.webm.bin";
import avc10 from "./fixtures/thumbnail-10bit-avc.mp4.bin";
import hevc10 from "./fixtures/thumbnail-10bit-hevc.mp4.bin";
import vp9_10 from "./fixtures/thumbnail-10bit-vp9.webm.bin";

vi.mock("ffmpeg-tiny", async (importOriginal) => {
  const decoder = await importOriginal<typeof import("ffmpeg-tiny")>();
  return { ...decoder, decodeFrame: vi.fn(decoder.decodeFrame) };
});
beforeEach(() => {
  vi.mocked(decodeFrame).mockClear();
});

// Synthetic FFmpeg fixtures: one second of 64x64 #2266aa VP8; one 96x64
// H.264 frame, red left/blue right, with setsar=2/1 and faststart.
// Format fixtures: one gray 64x64 frame with a BT.709 matrix. PQ H.264 and
// HLG VP9 use 8-bit YUV420; the SDR 10-bit variants use libx264/libx265/libvpx-vp9.
// MP4s use frag_keyframe+empty_moov. The HDR cases isolate transfer metadata
// from bit depth and matrix rejection.
async function stored(bytes: ArrayBuffer, now = Date.now()) {
  const fileId = crypto.randomUUID();
  const key = `thumbnail-test/${fileId}`;
  const object = await env.ATTACHMENTS.put(key, bytes);
  if (!object) throw new Error("Fixture PUT failed");
  const signed = await mintAttachmentGrant(
    env,
    {
      fileId,
      generation: "fixture-generation",
      messageId: "fixture-message",
      filename: "private-video.webm",
      objectKey: key,
      etag: object.etag,
      version: object.version,
      byteLength: bytes.byteLength,
    },
    now,
  );
  return {
    ...signed,
    key,
    url: fileThumbnailPath(fileGrantPath(signed.token)),
  };
}

const app = createHttpApp();
const request = (url: string, init?: RequestInit) =>
  app.request(new Request(new URL(url, env.AUTH_ORIGIN), init), undefined, env);

describe("private video thumbnails", () => {
  it.each([
    ["VP8 WebM", webm, 64, 64, [34, 102, 170]],
    ["H.264 MP4 with non-square pixels", mp4, 192, 64, [254, 0, 0]],
  ] as const)(
    "decodes %s through the granted route and logs metrics",
    async (_, fixture, width, height, expected) => {
      const file = await stored(fixture);
      const logger = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const response = await request(file.url);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(response.headers.get("Cache-Control")).toBe(
          "private, max-age=300, must-revalidate",
        );
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        for (const header of [
          "X-Read-Bytes",
          "X-Read-Calls",
          "X-Wasm-Heap-Bytes",
          "X-Source-Bytes",
          "X-WebCodecs",
        ])
          expect(response.headers.has(header)).toBe(false);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const png = decode(bytes);
        expect([png.width, png.height, png.channels]).toEqual([
          width,
          height,
          3,
        ]);
        for (let channel = 0; channel < 3; channel++)
          expect(
            Math.abs(Number(png.data[channel]) - expected[channel]!),
          ).toBeLessThanOrEqual(3);
        if (fixture === mp4) {
          const right = (width - 1) * 3;
          expect(Array.from(png.data.slice(right, right + 3))).toEqual([
            0, 0, 255,
          ]);
        }
        expect(logger).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "attachment_thumbnail",
            status: 200,
            sourceBytes: fixture.byteLength,
            outputBytes: bytes.byteLength,
            readBytes: fixture.byteLength,
            readCalls: 1,
            durationMs: expect.any(Number),
            wasmMemoryBytes: expect.any(Number),
          }),
        );
        const logs = JSON.stringify(logger.mock.calls);
        expect(logs).not.toContain(file.token);
        expect(logs).not.toContain(file.key);
        expect(logs).not.toContain("private-video");
      } finally {
        logger.mockRestore();
      }
    },
  );

  it("revalidates the PNG without R2 reads and keeps its ETag separate from the source", async () => {
    const file = await stored(webm);
    const claims = await verifyAttachmentGrant(env, file.token);
    if (!claims) throw new Error("Missing fixture grant");
    const response = await request(file.url);
    const etag = response.headers.get("ETag")!;
    const size = (await response.arrayBuffer()).byteLength;
    expect(etag).not.toBe(`"${claims.etag}"`);
    const get = vi.fn(env.ATTACHMENTS.get.bind(env.ATTACHMENTS));
    const cached = await serveThumbnail(
      new Request(new URL(file.url, env.AUTH_ORIGIN), {
        headers: { "If-None-Match": etag },
      }),
      { get },
      claims,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("Cache-Control")).toBe(
      "private, max-age=300, must-revalidate",
    );
    expect(get).not.toHaveBeenCalled();
    const head = await request(file.url, {
      method: "HEAD",
      headers: { Range: "bytes=0-1" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(etag);
    expect(head.headers.get("Content-Length")).toBe(String(size));
    expect(await head.text()).toBe("");
  });

  it.each([
    ["PQ H.264", pq],
    ["HLG VP9", hlg],
    ["10-bit H.264", avc10],
    ["10-bit HEVC", hevc10],
    ["10-bit VP9", vp9_10],
  ] as const)(
    "rejects %s before decoding and privately caches the refusal",
    async (_, fixture) => {
      const file = await stored(fixture);
      const logger = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const response = await request(file.url);
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe(
          "private, max-age=300, must-revalidate",
        );
        expect(decodeFrame).not.toHaveBeenCalled();
        expect(logger).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "attachment_thumbnail",
            status: 404,
            failureReason: "unsupported_format",
          }),
        );
      } finally {
        logger.mockRestore();
      }
    },
  );

  it.each([webm, pq])(
    "caps the cache lifetime at the grant expiry",
    async (fixture) => {
      const file = await stored(
        fixture,
        Date.now() - ATTACHMENT_GRANT_MS + 30_000,
      );
      const started = Date.now();
      const response = await request(file.url);
      expect(response.status).toBe(fixture === webm ? 200 : 404);
      const seconds = Number(
        /max-age=(\d+)/.exec(response.headers.get("Cache-Control") ?? "")?.[1],
      );
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(
        Math.floor((file.expiresAt - started) / 1_000),
      );
    },
  );

  it("keeps unexpected decoder failures uncached and logs no exception text", async () => {
    const file = await stored(webm);
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(decodeFrame).mockRejectedValueOnce(
      new Error("private decoder detail"),
    );
    try {
      const response = await request(file.url);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({ failureReason: "decode_failed" }),
      );
      expect(JSON.stringify(logger.mock.calls)).not.toContain(
        "private decoder detail",
      );
    } finally {
      logger.mockRestore();
    }
  });

  it("requires an unexpired grant and the application origin even for revalidation", async () => {
    const file = await stored(webm);
    const expired = await stored(webm, Date.now() - 2 * ATTACHMENT_GRANT_MS);
    const invalid = await request(fileThumbnailPath(fileGrantPath("invalid")));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
    const stale = await request(expired.url, {
      headers: { "If-None-Match": "*" },
    });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      (await request(file.url, { headers: { Origin: "https://other.test" } }))
        .status,
    ).toBe(403);
  });

  it("leaves unsupported, damaged, replaced and deleted sources without a thumbnail", async () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const [fixture, failureReason, cache] of [
        [
          new Uint8Array(new TextEncoder().encode("not a video")).buffer,
          "unsupported_format",
          "private, max-age=300, must-revalidate",
        ],
        [webm.slice(0, 64), "no_video", "private, no-store"],
      ] as const) {
        const file = await stored(fixture);
        const response = await request(file.url);
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe(cache);
        expect(logger).toHaveBeenLastCalledWith(
          expect.objectContaining({ failureReason }),
        );
      }
      const changed = await stored(webm);
      await env.ATTACHMENTS.put(changed.key, mp4);
      expect((await request(changed.url)).status).toBe(404);
      const deleted = await stored(webm);
      await env.ATTACHMENTS.delete(deleted.key);
      const response = await request(deleted.url);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(logger).toHaveBeenLastCalledWith(
        expect.objectContaining({ failureReason: "source_unavailable" }),
      );
    } finally {
      logger.mockRestore();
    }
  });
});
