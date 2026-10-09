import type { EncodedFrame } from "ffmpeg-tiny";
import type { ThumbnailDisplay } from "./format";

/** The DOM-typed demuxer stays behind a byte-only Worker interface. */
interface VideoPacket extends EncodedFrame {
  display: ThumbnailDisplay;
}

export function readVideoPacket(
  size: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<VideoPacket>;
