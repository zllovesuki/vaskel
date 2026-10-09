import type { z } from "zod";
import {
  providerError,
  RealtimeError,
  isAbsentSession,
  isAbsentTrack,
} from "./errors";
import { logEvent, type MediaDiagnosticContext } from "@/server/telemetry";
import {
  newSessionSchema,
  publicErrorSchema,
  sessionStateSchema,
  tracksResponseSchema,
} from "./schemas";
import type {
  SessionDescription,
  SessionStateResponse,
  TracksRequest,
  TracksResponse,
} from "./types";

export class RealtimeClient {
  readonly configured: boolean;
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    env: { REALTIME_APP_ID: string; REALTIME_APP_SECRET?: string },
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    options?: { timeoutMs?: number; maxResponseBytes?: number },
  ) {
    const appId = env.REALTIME_APP_ID.trim();
    this.secret = env.REALTIME_APP_SECRET?.trim() ?? "";
    this.configured = Boolean(appId && this.secret);
    this.baseUrl = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}`;
    this.timeoutMs = boundedOption(options?.timeoutMs, 10_000, 30_000);
    this.maxResponseBytes = boundedOption(
      options?.maxResponseBytes,
      1_048_576,
      1_048_576,
    );
  }

  createSession(
    context?: MediaDiagnosticContext,
  ): Promise<{ sessionId: string }> {
    return this.request(
      "create_session",
      "/sessions/new",
      "POST",
      201,
      newSessionSchema,
      undefined,
      context,
    );
  }

  addTracks(
    sessionId: string,
    body: TracksRequest,
    context?: MediaDiagnosticContext,
  ): Promise<TracksResponse> {
    return this.request(
      "add_tracks",
      this.sessionPath(sessionId, "/tracks/new"),
      "POST",
      200,
      tracksResponseSchema,
      body,
      context,
    );
  }

  renegotiate(
    sessionId: string,
    answer: SessionDescription,
    context?: MediaDiagnosticContext,
  ): Promise<TracksResponse> {
    return this.request(
      "renegotiate",
      this.sessionPath(sessionId, "/renegotiate"),
      "PUT",
      200,
      tracksResponseSchema,
      { sessionDescription: answer },
      context,
    );
  }

  closeTracks(
    sessionId: string,
    mids: string[],
    context?: MediaDiagnosticContext,
  ): Promise<TracksResponse> {
    return this.request(
      "close_tracks",
      this.sessionPath(sessionId, "/tracks/close"),
      "PUT",
      200,
      tracksResponseSchema,
      { force: true, tracks: mids.map((mid) => ({ mid })) },
      context,
    );
  }

  getSession(
    sessionId: string,
    context?: MediaDiagnosticContext,
  ): Promise<SessionStateResponse> {
    return this.request(
      "get_session",
      this.sessionPath(sessionId),
      "GET",
      200,
      sessionStateSchema,
      undefined,
      context,
    );
  }

  private sessionPath(sessionId: string, suffix = ""): string {
    return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  }

  private async request<
    T extends { sessionId: string } | TracksResponse | SessionStateResponse,
  >(
    operation:
      | "create_session"
      | "add_tracks"
      | "renegotiate"
      | "close_tracks"
      | "get_session",
    path: string,
    method: "GET" | "POST" | "PUT",
    expectedStatus: number,
    schema: z.ZodType<T>,
    body?: object,
    context?: MediaDiagnosticContext,
  ): Promise<T> {
    // Snapshot each invocation; a shared client never carries mutable correlation.
    const diagnostic = {
      actorId: context?.actorId,
      participantId: context?.participantId,
      generation: context?.generation,
      operationId: context?.operationId,
      direction: context?.direction,
      version: context?.version,
      cleanup: context?.cleanup,
      operation,
    };
    const absentSessionIsSuccess =
      diagnostic.cleanup === "session" &&
      (operation === "close_tracks" || operation === "get_session");
    const absentTrackIsSuccess =
      (diagnostic.cleanup === "tracks" || diagnostic.cleanup === "session") &&
      operation === "close_tracks";
    let providerStatus: number | undefined;
    let errorSource: "transport" | "response" | "top_level" = "transport";
    if (!this.configured) {
      const error = new RealtimeError("unavailable", 503, false, false);
      logEvent(
        "warn",
        "provider_request_failed",
        { ...diagnostic, errorSource },
        error,
      );
      throw error;
    }
    const started = Date.now();
    const mutation = method !== "GET";
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.timeoutMs;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new RealtimeError("timeout", 504, true, mutation));
        controller.abort();
        // Do not await cancellation: a hostile stream may never complete it.
        void reader?.cancel().catch(() => {});
      }, this.timeoutMs);
    });
    const execute = async (): Promise<T> => {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
      });
      providerStatus = response.status;
      errorSource = "response";
      if (expired) {
        void response.body?.cancel().catch(() => {});
        throw new RealtimeError("timeout", 504, true, mutation);
      }
      const invalid = () =>
        new RealtimeError("invalid_response", 502, false, mutation);
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        Number(declaredLength) > this.maxResponseBytes
      ) {
        void response.body?.cancel().catch(() => {});
        throw invalid();
      }
      if (!response.body) throw invalid();
      reader = response.body.getReader();
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      });
      while (true) {
        const chunk = await reader.read();
        if (expired || Date.now() >= deadlineAt)
          throw new RealtimeError("timeout", 504, true, mutation);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxResponseBytes) throw invalid();
        try {
          text += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw invalid();
        }
      }
      try {
        text += decoder.decode();
      } catch {
        throw invalid();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw invalid();
      }
      const publicError = publicErrorSchema.safeParse(payload);
      if (!publicError.success) throw invalid();
      if (
        publicError.data.errorCode !== undefined ||
        publicError.data.errorDescription !== undefined
      ) {
        errorSource = "top_level";
        throw providerError(
          publicError.data.errorCode ?? "provider_error",
          response.status,
        );
      }
      if (response.status !== expectedStatus)
        throw providerError("unexpected_status", response.status);
      const result = schema.safeParse(payload);
      if (!result.success) throw invalid();
      if (expired || Date.now() >= deadlineAt)
        throw new RealtimeError("timeout", 504, true, mutation);
      if ("tracks" in result.data) {
        const failures = result.data.tracks.filter(
          (track) =>
            (track.errorCode !== undefined ||
              track.errorDescription !== undefined) &&
            !(absentTrackIsSuccess && isAbsentTrack(track)),
        );
        if (failures.length > 0)
          logEvent("warn", "provider_track_failed", {
            ...diagnostic,
            providerStatus,
            errorSource: "track",
            durationMs: Date.now() - started,
            processed: result.data.tracks.length,
            failed: failures.length,
            succeeded: result.data.tracks.filter(
              (track) =>
                track.errorCode === undefined &&
                track.errorDescription === undefined,
            ).length,
            providerErrors: failures.map((track) => ({
              code: track.errorCode ?? "provider_error",
              count: 1,
            })),
          });
      }
      return result.data;
    };
    try {
      return await Promise.race([execute(), deadline]);
    } catch (error) {
      const failure =
        error instanceof RealtimeError
          ? error
          : new RealtimeError(
              expired ? "timeout" : "network_error",
              expired ? 504 : 503,
              true,
              mutation,
            );
      if (!(absentSessionIsSuccess && isAbsentSession(failure)))
        logEvent(
          "warn",
          "provider_request_failed",
          {
            ...diagnostic,
            providerStatus,
            errorSource,
            durationMs: Date.now() - started,
          },
          failure,
        );
      throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), maximum)
    : fallback;
}
