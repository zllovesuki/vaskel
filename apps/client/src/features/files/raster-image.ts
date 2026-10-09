import { detectInlineContentType } from "@vaskel/contracts/attachments";

/** A fetch hint only. Existing uploads do not need persisted image metadata. */
export const automaticImagePreview = (filename: string): boolean =>
  /\.(?:png|jpe?g|gif|webp)$/i.test(filename.trim());

/** A hint for the Play control only; the granted route decides what plays. */
export const automaticVideoPlayback = (filename: string): boolean =>
  /\.(?:mp4|m4v|mov|webm)$/i.test(filename.trim());

/** Local previews admit raster bytes only; the server decides what a sent file displays. */
export function detectRasterContentType(bytes: Uint8Array) {
  const type = detectInlineContentType(bytes);
  return type?.startsWith("image/") ? type : null;
}
