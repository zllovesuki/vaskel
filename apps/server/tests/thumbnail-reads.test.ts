import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { ATTACHMENT_BYTE_LIMIT } from "@vaskel/contracts/attachments";
import type { GrantClaims } from "@/server/files/grant";
import { serveThumbnail } from "@/server/files/thumbnail";
import { generateThumbnail } from "@/server/files/thumbnail/generate";
import mp4 from "./fixtures/thumbnail.mp4.bin";

// Control decoder reads while exercising the real reader and R2 binding.
// attachment-thumbnail.test.ts separately covers actual demuxing and decoding.
vi.mock("@/server/files/thumbnail/generate", () => ({
  generateThumbnail: vi.fn(),
}));

const CHUNK_BYTES = 32 * 1_024;
const output = { bytes: new Uint8Array([1]), wasmMemoryBytes: 0 };

afterEach(() => {
  vi.mocked(generateThumbnail).mockReset();
  vi.restoreAllMocks();
});

async function source(size = 4 * CHUNK_BYTES) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  bytes.set(new Uint8Array(mp4, 0, 64));
  const key = `thumbnail-reads/${crypto.randomUUID()}`;
  const object = await env.ATTACHMENTS.put(key, bytes);
  if (!object) throw new Error("Fixture PUT failed");
  const claims: GrantClaims = {
    aud: "vaskel:attachment",
    iat: 0,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    fileId: crypto.randomUUID(),
    key,
    etag: object.etag,
    version: object.version,
    byteLength: size,
    filename: "fixture.mp4",
  };
  return {
    bytes,
    claims,
    request: new Request("https://vaskel.test/thumbnail"),
    get: vi.fn(env.ATTACHMENTS.get.bind(env.ATTACHMENTS)),
    logger: vi.spyOn(console, "log").mockImplementation(() => {}),
  };
}

it("shares the signature chunk and retains it across a visit to tail metadata", async () => {
  const file = await source();
  const tail = file.bytes.length - 100;
  vi.mocked(generateThumbnail).mockImplementationOnce(async (size, read) => {
    expect(size).toBe(file.bytes.length);
    for (const [start, end] of [
      [0, 12],
      [12, 16],
      [16, 48],
      [tail, tail + 16],
      [tail + 16, size],
      [64, 1_024],
    ] as const) {
      const bytes = await read(start, end);
      expect(bytes).toEqual(file.bytes.slice(start, end));
      expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
    }
    return output;
  });
  const response = await serveThumbnail(file.request, file, file.claims);
  expect(response.status).toBe(200);
  expect(file.get.mock.calls).toEqual([
    [
      file.claims.key,
      {
        range: { offset: 0, length: CHUNK_BYTES },
        onlyIf: { etagMatches: file.claims.etag },
      },
    ],
    [
      file.claims.key,
      {
        range: { offset: tail, length: 100 },
        onlyIf: { etagMatches: file.claims.etag },
      },
    ],
  ]);
  expect(file.logger).toHaveBeenCalledWith(
    expect.objectContaining({ readCalls: 2, readBytes: CHUNK_BYTES + 100 }),
  );
});

it("fetches a known large range once without displacing either small chunk", async () => {
  const file = await source();
  vi.mocked(generateThumbnail).mockImplementationOnce(async (size, read) => {
    await read(size - 100, size);
    const start = CHUNK_BYTES;
    const end = 3 * CHUNK_BYTES + 1;
    expect(await read(start, end)).toEqual(file.bytes.slice(start, end));
    expect(await read(0, 64)).toEqual(file.bytes.slice(0, 64));
    expect(await read(size - 100, size)).toEqual(file.bytes.slice(-100));
    return output;
  });
  expect((await serveThumbnail(file.request, file, file.claims)).status).toBe(
    200,
  );
  expect(file.get).toHaveBeenCalledTimes(3);
  expect(file.get).toHaveBeenLastCalledWith(file.claims.key, {
    range: { offset: CHUNK_BYTES, length: 2 * CHUNK_BYTES + 1 },
    onlyIf: { etagMatches: file.claims.etag },
  });
});

it("handles a chunk boundary and evicts old data after two buffered reads", async () => {
  const file = await source();
  vi.mocked(generateThumbnail).mockImplementationOnce(async (_, read) => {
    for (const [start, end] of [
      [CHUNK_BYTES - 1, CHUNK_BYTES + 1],
      [3 * CHUNK_BYTES, 3 * CHUNK_BYTES + 10],
      [0, 64],
    ] as const)
      expect(await read(start, end)).toEqual(file.bytes.slice(start, end));
    return output;
  });
  expect((await serveThumbnail(file.request, file, file.claims)).status).toBe(
    200,
  );
  expect(file.get.mock.calls.map(([, options]) => options?.range)).toEqual([
    { offset: 0, length: CHUNK_BYTES },
    { offset: CHUNK_BYTES - 1, length: CHUNK_BYTES },
    { offset: 3 * CHUNK_BYTES, length: CHUNK_BYTES },
    { offset: 0, length: CHUNK_BYTES },
  ]);
});

it("counts read-ahead bytes against the extraction budget", async () => {
  const file = await source(ATTACHMENT_BYTE_LIMIT);
  vi.mocked(generateThumbnail).mockImplementationOnce(async (size, read) => {
    await read(0, size);
    await read(0, size);
    return output;
  });
  const response = await serveThumbnail(file.request, file, file.claims);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(file.get).toHaveBeenCalledTimes(2);
  expect(file.logger).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 404,
      failureReason: "read_limit",
      readCalls: 2,
      readBytes: ATTACHMENT_BYTE_LIMIT + CHUNK_BYTES,
    }),
  );
});

it("limits R2 requests while allowing repeated cache hits", async () => {
  const file = await source();
  vi.mocked(generateThumbnail).mockImplementationOnce(async (_, read) => {
    for (let index = 0; index < 128; index++) await read(0, 12);
    for (let index = 0; index <= 128; index++) {
      const start = (index % 3) * CHUNK_BYTES;
      await read(start, start + 12);
    }
    return output;
  });
  expect((await serveThumbnail(file.request, file, file.claims)).status).toBe(
    404,
  );
  expect(file.get).toHaveBeenCalledTimes(128);
  expect(file.logger).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 404,
      failureReason: "read_limit",
      readCalls: 128,
      readBytes: 128 * CHUNK_BYTES,
    }),
  );
});

it("honors cancellation even when the next read is cached", async () => {
  const file = await source();
  const controller = new AbortController();
  const request = new Request(file.request, { signal: controller.signal });
  vi.mocked(generateThumbnail).mockImplementationOnce(async (_, read) => {
    controller.abort();
    await read(0, 12);
    return output;
  });
  const response = await serveThumbnail(request, file, file.claims);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(file.get).toHaveBeenCalledTimes(1);
  expect(file.logger).toHaveBeenCalledWith(
    expect.objectContaining({ failureReason: "cancelled" }),
  );
});

it("preserves storage failures and keeps private exception text out of telemetry", async () => {
  const file = await source();
  const error = new Error("private storage detail");
  file.get.mockRejectedValueOnce(error);
  await expect(serveThumbnail(file.request, file, file.claims)).rejects.toBe(
    error,
  );
  expect(file.logger).toHaveBeenCalledWith(
    expect.objectContaining({ status: 500, failureReason: "storage_failed" }),
  );
  expect(JSON.stringify(file.logger.mock.calls)).not.toContain(
    "private storage detail",
  );
});
