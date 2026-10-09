import type { TrackResult } from "./types";

export class RealtimeError extends Error {
  readonly code: string;

  constructor(
    code: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly uncertain: boolean,
  ) {
    const safeCode = /^[a-z][a-z0-9_]{0,79}$/.test(code)
      ? code
      : "provider_error";
    super(`Realtime operation failed (${safeCode}).`);
    this.name = "RealtimeError";
    this.code = safeCode;
  }
}

const permanentCodes = new Set([
  "unauthorized",
  "not_found",
  "decoding_error",
  "invalid_params",
  "payload_too_large",
  "invalid_session_description",
]);
const transientCodes = new Set([
  "retryable_transient_error",
  "temporarily_unavailable_error",
  "transport_unavailable_error",
  "backend_error",
]);

export function providerError(code: string, status: number): RealtimeError {
  const retryable =
    !permanentCodes.has(code) &&
    (transientCodes.has(code) ||
      status === 429 ||
      (code === "session_error" && status === 425));
  return new RealtimeError(code, status, retryable, false);
}

export function isAbsentTrack(result: TrackResult): boolean {
  return result.errorCode === "close_track_error";
}

export function isAbsentSession(error: unknown): boolean {
  return (
    error instanceof RealtimeError &&
    error.status === 410 &&
    error.code === "session_error"
  );
}
