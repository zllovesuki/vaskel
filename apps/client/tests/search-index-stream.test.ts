import { failureResponse } from "@tests/helpers/http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sseData } from "@/client/api/sse";

let api: typeof import("@/client/api/search-index");
let client: typeof import("@/client/api/client");
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  api = await import("@/client/api/search-index");
  client = await import("@/client/api/client");
});
afterAll(() => vi.unstubAllGlobals());
const counts = { rebuilt: 2, failed: 0, indexedMessages: 7 };
const frame = (value: unknown) =>
  `event: rebuild\ndata: ${JSON.stringify(value)}\n\n`;
const response = (body: BodyInit) =>
  new Response(body, { headers: { "Content-Type": "text/event-stream" } });

it("decodes split UTF-8, multiline data and CRLF without retaining previous frames", async () => {
  const bytes = new TextEncoder().encode(
    ": comment\r\n\r\nevent: rebuild\r\ndata: 日本語\r\ndata: next\r\n\r\n",
  );
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const received = [];
  for await (const value of sseData(
    body,
    new AbortController().signal,
    () => {},
  ))
    received.push(value);
  expect(received).toEqual(["日本語\nnext"]);
});

it("uses one authenticated POST and requires explicit completion", async () => {
  const fetch = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) =>
    response(
      frame({ type: "progress", ...counts }) +
        frame({ type: "complete", ...counts }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const progress = vi.fn();
  const failed = vi.fn();
  const restore = client.installRequestAccess({
    begin: () => ({ accountId: "operator", current: () => true }),
    failed,
  });
  try {
    expect(
      await api.rebuildSearchIndexes(progress, new AbortController().signal),
    ).toEqual({ type: "complete", ...counts });
    expect(progress).toHaveBeenCalledWith({ type: "progress", ...counts });
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("X-Vaskel-Expected-Account")).toBe(
      "operator",
    );
    expect(failed).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

it.each([
  frame({ type: "progress", ...counts }),
  frame({ type: "complete", ...counts }).trimEnd(),
  "data: not JSON\n\n",
  frame({ type: "complete", rebuilt: -1, failed: 0, indexedMessages: 0 }),
])("rejects incomplete or invalid stream outcomes", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(body)),
  );
  await expect(
    api.rebuildSearchIndexes(() => {}, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it("handles HTTP and streamed authorization failures through the existing access boundary", async () => {
  const failed = vi.fn();
  const restore = client.installRequestAccess({
    begin: () => ({ accountId: "operator", current: () => true }),
    failed,
  });
  try {
    for (const result of [
      failureResponse({ kind: "unauthenticated" }, { status: 401 }),
      response(frame({ type: "error", kind: "unauthenticated" })),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => result),
      );
      await expect(
        api.rebuildSearchIndexes(() => {}, new AbortController().signal),
      ).rejects.toMatchObject({ code: "unauthenticated" });
    }
    expect(failed).toHaveBeenCalledTimes(2);
  } finally {
    restore();
  }
});

it("rejects late account results and cancels a pending read when leaving the page", async () => {
  let current = true;
  const failed = vi.fn();
  const restore = client.installRequestAccess({
    begin: () => ({ accountId: "operator", current: () => current }),
    failed,
  });
  try {
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: canceled });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(body)),
    );
    const abort = new AbortController();
    const run = api.rebuildSearchIndexes(() => {}, abort.signal);
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    abort.abort();
    await rejected;
    expect(canceled).toHaveBeenCalledTimes(1);
    const progress = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        current = false;
        return response(frame({ type: "complete", ...counts }));
      }),
    );
    await expect(
      api.rebuildSearchIndexes(progress, new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});
