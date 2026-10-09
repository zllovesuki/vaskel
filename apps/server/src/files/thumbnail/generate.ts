import { decodeFrame } from "ffmpeg-tiny";
import decoder from "ffmpeg-tiny/decoder.wasm";
import { readVideoPacket } from "./demux.mjs";
import { renderThumbnail } from "./render";
import { ThumbnailError } from "./errors";

export async function generateThumbnail(
  size: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
) {
  const packet = await readVideoPacket(size, read);
  const frame = await decodeFrame(decoder, packet).catch((error: unknown) => {
    // ffmpeg-tiny also checks the actual decoded format when metadata is absent.
    if (
      error instanceof Error &&
      error.message === "Only 8-bit planar YUV 4:2:0 output is supported"
    )
      throw new ThumbnailError("unsupported_format");
    throw new ThumbnailError("decode_failed");
  });
  try {
    return {
      bytes: renderThumbnail(frame, {
        ...packet.display,
        fullRange: frame.fullRange ?? packet.display.fullRange ?? false,
      }),
      wasmMemoryBytes: frame.wasmMemoryBytes,
    };
  } catch {
    throw new ThumbnailError("render_failed");
  } finally {
    frame.close();
  }
}
