import { describe, expect, it } from "vitest";
import {
  dragCarriesFiles,
  filesFromDataTransfer,
  type TransferItemLike,
} from "@/client/features/files/drop-files";

// Only identity and order matter here, so a stand-in avoids depending on a File global.
class FakeFile {
  constructor(readonly name: string) {}
}
const fileNamed = (name: string) => new FakeFile(name) as unknown as File;
const fileItem = (file: File | null): TransferItemLike => ({
  kind: "file",
  getAsFile: () => file,
});
const textItem: TransferItemLike = { kind: "string", getAsFile: () => null };

describe("composer drop payloads", () => {
  it("recognizes a file drag from either types shape and refuses text drags", () => {
    expect(dragCarriesFiles(["Files", "application/x-moz-file"])).toBe(true);
    expect(dragCarriesFiles(["text/plain", "text/uri-list"])).toBe(false);
    expect(dragCarriesFiles([])).toBe(false);
    // Older browsers expose types as a DOMStringList rather than an array.
    const listed = (...types: string[]) =>
      ({
        length: types.length,
        contains: (value: string) => types.includes(value),
        item: (index: number) => types[index] ?? null,
      }) as unknown as DOMStringList;
    expect(dragCarriesFiles(listed("Files"))).toBe(true);
    expect(dragCarriesFiles(listed("text/plain"))).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });

  it("prefers transfer items in order without repeats", () => {
    const notes = fileNamed("notes.txt");
    const image = fileNamed("image.png");
    const stale = fileNamed("stale.bin");
    expect(
      filesFromDataTransfer({
        items: [fileItem(notes), textItem, fileItem(image), fileItem(notes)],
        files: [stale],
      }),
    ).toEqual([notes, image]);
  });

  it("falls back to the file list when no item yields a file", () => {
    const notes = fileNamed("notes.txt");
    const image = fileNamed("image.png");
    expect(
      filesFromDataTransfer({
        items: [textItem, fileItem(null)],
        files: [notes, image],
      }),
    ).toEqual([notes, image]);
    expect(filesFromDataTransfer({ files: [notes] })).toEqual([notes]);
  });

  it("reads an absent or empty transfer as no selection", () => {
    expect(filesFromDataTransfer(null)).toEqual([]);
    expect(filesFromDataTransfer(undefined)).toEqual([]);
    expect(filesFromDataTransfer({ items: [], files: [] })).toEqual([]);
  });
});
