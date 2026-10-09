import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  brandColours,
  ICO,
  pngFiles,
  SHARE_CARD,
  SURFACES,
  textFiles,
} from "../src/brand.ts";

// The committed master under brand/ is what the applications ship; it must
// stay what `pnpm run brand` emits from the geometry and the current theme.
const ui = new URL("../", import.meta.url);
const master = (path: string) => readFileSync(new URL(`brand/${path}`, ui));
const colours = brandColours(
  readFileSync(new URL("src/theme.css", ui), "utf8"),
);
const pngSize = (bytes: Buffer) => {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

describe("brand master", () => {
  it("keeps the text files equal to the generator", () => {
    for (const [path, text] of Object.entries(textFiles(colours)))
      expect(master(path).toString("utf8"), path).toBe(text);
  });

  it("keeps every raster at its size", () => {
    for (const { path, size } of pngFiles(colours))
      expect(pngSize(master(path)), path).toEqual([size, size]);
    expect(pngSize(master(SHARE_CARD.path))).toEqual([
      SHARE_CARD.width,
      SHARE_CARD.height,
    ]);
  });

  it("carries the tab sizes as PNG members of the ICO", () => {
    const bytes = master(ICO.path);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBe(ICO.sizes.length);
    ICO.sizes.forEach((size, index) => {
      const entry = 6 + 16 * index;
      expect(bytes.readUInt8(entry)).toBe(size);
      expect(bytes.readUInt8(entry + 1)).toBe(size);
      const offset = bytes.readUInt32LE(entry + 12);
      const member = bytes.subarray(
        offset,
        offset + bytes.readUInt32LE(entry + 8),
      );
      expect(pngSize(member), `${size} px member`).toEqual([size, size]);
    });
  });

  it("ships only master files on every surface", () => {
    const known = new Set([
      ...Object.keys(textFiles(colours)),
      ...pngFiles(colours).map((file) => file.path),
      ICO.path,
      SHARE_CARD.path,
    ]);
    for (const files of Object.values(SURFACES))
      for (const file of files) expect(known.has(file), file).toBe(true);
  });
});
