import { EventSourceParserStream, ParseError } from "eventsource-parser/stream";
import { ApiError } from "./errors";

/** Parser-owned framing; application-owned cancellation and account lifetime. */
export async function* sseData(
  body: ReadableStream<BufferSource>,
  signal: AbortSignal,
  checkCurrent: () => void,
) {
  const reader = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new EventSourceParserStream({
        onError: "terminate",
        maxBufferSize: 64 * 1024,
      }),
    )
    .getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      checkCurrent();
      const part = await reader.read();
      checkCurrent();
      if (part.done) break;
      yield part.value.data;
    }
  } catch (error) {
    if (error instanceof ParseError)
      throw new ApiError("unavailable", undefined, "contract");
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
