import { encode } from "fast-png";
import type { DecodedFrame } from "ffmpeg-tiny";
import type { ThumbnailDisplay } from "./format";

/** Sample borrowed YUV planes directly into a small RGB image. */
export function renderThumbnail(
  frame: DecodedFrame,
  display: ThumbnailDisplay,
) {
  const { rotation, flip, pixelAspectRatio, matrix, fullRange } = display;
  const rotated = rotation === 90 || rotation === 270;
  const squareWidth = frame.width * pixelAspectRatio;
  const displayWidth = rotated ? frame.height : squareWidth;
  const displayHeight = rotated ? squareWidth : frame.height;
  const scale = Math.min(1, 320 / displayWidth, 320 / displayHeight);
  const width = Math.max(1, Math.round(displayWidth * scale));
  const height = Math.max(1, Math.round(displayHeight * scale));
  const rgb = new Uint8Array(width * height * 3);
  const kr = matrix === "bt709" ? 0.2126 : 0.299;
  const kb = matrix === "bt709" ? 0.0722 : 0.114;
  const kg = 1 - kr - kb;
  const yScale = fullRange ? 1 : 255 / 219;
  const yOffset = fullRange ? 0 : 16;
  const cScale = fullRange ? 1 : 255 / 224;
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const sampleWidth = rotated ? frame.height : frame.width;
  const sampleHeight = rotated ? frame.width : frame.height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = Math.min(
        sampleWidth - 1,
        Math.floor(((x + 0.5) * sampleWidth) / width),
      );
      const dy = Math.min(
        sampleHeight - 1,
        Math.floor(((y + 0.5) * sampleHeight) / height),
      );
      const rx = flip ? sampleWidth - 1 - dx : dx;
      const sx =
        rotation === 90
          ? dy
          : rotation === 270
            ? frame.width - 1 - dy
            : rotation === 180
              ? frame.width - 1 - rx
              : rx;
      const sy =
        rotation === 90
          ? frame.height - 1 - rx
          : rotation === 270
            ? rx
            : rotation === 180
              ? frame.height - 1 - dy
              : dy;
      const luma = yScale * (frame.y.data[sy * frame.y.stride + sx]! - yOffset);
      const cb =
        cScale * (frame.u.data[(sy >> 1) * frame.u.stride + (sx >> 1)]! - 128);
      const cr =
        cScale * (frame.v.data[(sy >> 1) * frame.v.stride + (sx >> 1)]! - 128);
      const dest = (y * width + x) * 3;
      rgb[dest] = clamp(luma + 2 * (1 - kr) * cr);
      rgb[dest + 1] = clamp(
        luma -
          ((2 * kb * (1 - kb)) / kg) * cb -
          ((2 * kr * (1 - kr)) / kg) * cr,
      );
      rgb[dest + 2] = clamp(luma + 2 * (1 - kb) * cb);
    }
  }
  return encode({ width, height, data: rgb, channels: 3 }).slice();
}
