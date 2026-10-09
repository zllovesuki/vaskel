/** Drag and clipboard payload reading, kept free of DOM construction for tests. */

export interface TransferItemLike {
  kind: string;
  getAsFile(): File | null;
}
export interface FileTransferLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<TransferItemLike> | null;
}

/** A file drag announces "Files" in its types; text and link drags never do. */
export function dragCarriesFiles(
  types: readonly string[] | DOMStringList | undefined,
): boolean {
  if (!types) return false;
  if ("contains" in types) return types.contains("Files");
  return Array.from(types).includes("Files");
}

/** Items describe the dropped or pasted entries; a plain file list is the fallback. */
export function filesFromDataTransfer(
  transfer: FileTransferLike | null | undefined,
): File[] {
  if (!transfer) return [];
  const picked = new Set<File>();
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) picked.add(file);
  }
  return picked.size ? [...picked] : Array.from(transfer.files ?? []);
}
