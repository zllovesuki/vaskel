import {
  CustomSource,
  EncodedPacketSink,
  Input,
  MP4,
  QTFF,
  WEBM,
} from "mediabunny";
import { ThumbnailError } from "./errors.ts";
import { checkThumbnailDisplay, checkThumbnailPixelFormat } from "./format.ts";

// Mediabunny's declarations require DOM types that conflict with Workers.
// tsconfig.demux.json checks this adapter and its declared interface together.
/** @type {typeof import("./demux.d.mts").readVideoPacket} */
export const readVideoPacket = async (size, read) => {
  const input = new Input({
    formats: [MP4, QTFF, WEBM],
    source: new CustomSource({
      getSize: () => size,
      read,
      prefetchProfile: "none",
      maxCacheSize: 2 * 1_024 * 1_024,
    }),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new ThumbnailError("no_video");
    const codec = await track.getCodec();
    if (
      codec !== "avc" &&
      codec !== "hevc" &&
      codec !== "vp8" &&
      codec !== "vp9"
    )
      throw new ThumbnailError("unsupported_codec");
    const config = await track.getDecoderConfig();
    if (!config) throw new ThumbnailError("demux_failed");
    const rotation = await track.getRotation();
    const flip = await track.getFlip();
    const aspect = await track.getPixelAspectRatio();
    const description = config.description;
    const extra = !description
      ? undefined
      : ArrayBuffer.isView(description)
        ? new Uint8Array(
            description.buffer,
            description.byteOffset,
            description.byteLength,
          )
        : new Uint8Array(description);
    const display = {
      rotation,
      flip,
      pixelAspectRatio: aspect.num / aspect.den,
      matrix: config.colorSpace?.matrix ?? null,
      transfer: config.colorSpace?.transfer ?? null,
      fullRange: config.colorSpace?.fullRange ?? null,
    };
    checkThumbnailDisplay(display);
    checkThumbnailPixelFormat(config.codec, extra);
    const packet = await new EncodedPacketSink(track).getFirstKeyPacket({
      verifyKeyPackets: true,
    });
    if (!packet) throw new ThumbnailError("no_keyframe");
    return {
      codec: codec === "avc" ? "h264" : codec,
      data: packet.data,
      ...(extra ? { description: extra } : {}),
      display,
    };
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    throw new ThumbnailError("demux_failed");
  } finally {
    input.dispose();
  }
};
