import { ThumbnailError } from "./errors";

export interface ThumbnailDisplay {
  rotation: number;
  flip: boolean;
  pixelAspectRatio: number;
  matrix: string | null;
  transfer: string | null;
  fullRange: boolean | null;
}

export function checkThumbnailDisplay(display: ThumbnailDisplay) {
  const { rotation, pixelAspectRatio, matrix, transfer } = display;
  if (
    ![0, 90, 180, 270].includes(rotation) ||
    !Number.isFinite(pixelAspectRatio) ||
    pixelAspectRatio <= 0 ||
    (matrix !== null && !["bt709", "bt470bg", "smpte170m"].includes(matrix)) ||
    transfer === "pq" ||
    transfer === "hlg"
  )
    throw new ThumbnailError("unsupported_format");
}

/** Inspect explicit configuration fields; absent metadata still reaches the decoder. */
export function checkThumbnailPixelFormat(
  codec: string,
  description: Uint8Array | undefined,
) {
  if (codec.startsWith("vp09.")) {
    const parts = codec.split(".");
    const depth = parts[3];
    const chroma = parts[4];
    if (
      (depth !== undefined && /^\d{2}$/.test(depth) && depth !== "08") ||
      chroma === "02" ||
      chroma === "03"
    )
      throw new ThumbnailError("unsupported_format");
    return;
  }
  if (!description || description[0] !== 1) return;

  let offset: number;
  if (/^(hev1|hvc1)\./.test(codec)) {
    if (description.length < 23) return;
    // hvcC places chromaFormat and the two bitDepthMinus8 fields at bytes 16–18.
    offset = 16;
  } else if (/^avc[13]\./.test(codec)) {
    if (
      description.length < 7 ||
      ![100, 110, 122, 144].includes(description[1]!)
    )
      return;
    // avcC's optional format extension follows its length-prefixed SPS/PPS arrays.
    offset = 6;
    let count = description[5]! & 31;
    for (let array = 0; array < 2; array++) {
      for (let index = 0; index < count; index++) {
        if (offset + 2 > description.length) return;
        const length = (description[offset]! << 8) | description[offset + 1]!;
        offset += 2 + length;
        if (offset > description.length) return;
      }
      if (array === 0) {
        if (offset >= description.length) return;
        count = description[offset++]!;
      }
    }
    if (offset + 3 > description.length) return;
  } else return;

  if (
    (description[offset]! & 3) !== 1 ||
    (description[offset + 1]! & 7) !== 0 ||
    (description[offset + 2]! & 7) !== 0
  )
    throw new ThumbnailError("unsupported_format");
}
