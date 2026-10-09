export type ThumbnailFailureReason =
  | "unsupported_codec"
  | "unsupported_format"
  | "no_video"
  | "no_keyframe"
  | "demux_failed"
  | "decode_failed"
  | "render_failed"
  | "read_limit"
  | "cancelled"
  | "source_unavailable"
  | "storage_failed"
  | "internal_error";

/** Only locally chosen reasons cross into thumbnail telemetry and cache policy. */
export class ThumbnailError extends Error {
  readonly reason: ThumbnailFailureReason;

  constructor(reason: ThumbnailFailureReason) {
    super(reason);
    this.reason = reason;
  }
}
