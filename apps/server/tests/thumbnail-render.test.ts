import { decode } from "fast-png";
import type { DecodedFrame } from "ffmpeg-tiny";
import { describe, expect, it } from "vitest";
import { renderThumbnail } from "@/server/files/thumbnail/render";

const frame: DecodedFrame = {
  format: "yuv420p",
  width: 2,
  height: 4,
  fullRange: true,
  wasmMemoryBytes: 0,
  y: {
    data: new Uint8Array([0, 40, 99, 80, 120, 99, 160, 200, 99, 240, 255]),
    stride: 3,
    width: 2,
    height: 4,
  },
  u: { data: new Uint8Array([128, 99, 128]), stride: 2, width: 1, height: 2 },
  v: { data: new Uint8Array([128, 99, 128]), stride: 2, width: 1, height: 2 },
  close() {},
};
const display = {
  rotation: 90,
  flip: false,
  pixelAspectRatio: 1,
  matrix: null,
  transfer: null,
  fullRange: true,
};

describe("thumbnail rendering", () => {
  it("honors rotation, post-rotation mirroring and padded plane strides", () => {
    const image = decode(renderThumbnail(frame, display));
    expect([image.width, image.height]).toEqual([4, 2]);
    expect(Array.from(image.data).filter((_, i) => i % 3 === 0)).toEqual([
      240, 160, 80, 0, 255, 200, 120, 40,
    ]);
    const mirrored = decode(renderThumbnail(frame, { ...display, flip: true }));
    expect(Array.from(mirrored.data).filter((_, i) => i % 3 === 0)).toEqual([
      0, 80, 160, 240, 40, 120, 200, 255,
    ]);
  });

  it("bounds both output dimensions", () => {
    const image = decode(
      renderThumbnail(frame, { ...display, pixelAspectRatio: 1000 }),
    );
    expect([image.width, image.height]).toEqual([1, 320]);
  });
});
