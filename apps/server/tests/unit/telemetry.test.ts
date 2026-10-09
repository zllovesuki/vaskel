import { describe, expect, it, vi } from "vitest";
import { logEvent } from "@/server/telemetry";
import { RealtimeError } from "@/server/providers/realtime/errors";

describe("operational diagnostics failure boundaries", () => {
  it("projects fields and classifies errors without reading private text or unknown codes", () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fields = {
        requestId: "safe-reference",
        payload: "private body",
        token: "secret",
        storedName: "private stored name",
        sql: "private SQL",
      };
      const error = new TypeError("private message");
      error.name = "private-name";
      error.stack = "private-stack";
      error.cause = { secret: "private-cause" };
      logEvent("warn", "request_failed", fields, error);
      expect(logger).toHaveBeenLastCalledWith({
        event: "request_failed",
        requestId: "safe-reference",
        errorName: "TypeError",
      });
      logEvent(
        "warn",
        "provider_request_failed",
        {},
        new RealtimeError("private_token", 500, false, false),
      );
      expect(logger).toHaveBeenLastCalledWith({
        event: "provider_request_failed",
        errorName: "RealtimeError",
        code: "provider_error",
        retryable: false,
        uncertain: false,
      });
      logEvent(
        "warn",
        "request_failed",
        {},
        {
          get name() {
            throw new Error("must not read");
          },
        },
      );
      expect(logger).toHaveBeenLastCalledWith({
        event: "request_failed",
        errorName: "UnknownError",
      });
      expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private|secret/);
    } finally {
      logger.mockRestore();
    }
  });
});

describe("media diagnostics projection", () => {
  it("aggregates allowlisted codes and omits private track, transport and request fields", () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fields = {
        actorId: "actor",
        participantId: "participant",
        generation: 2,
        operationId: "operation",
        direction: "consumer" as const,
        version: 3,
        providerStatus: 200,
        errorSource: "track" as const,
        providerErrors: [
          { code: "empty_track_error", count: 1, errorDescription: "private" },
          { code: "not_found_track_error", count: 2 },
          ...Array.from({ length: 100 }, (_, i) => ({
            code: `private_${i}`,
            count: 1,
          })),
        ],
        sdp: "private",
        address: "private",
        deviceToken: "private",
        sessionId: "private",
        trackName: "private",
        headers: { authorization: "private" },
      };
      logEvent("warn", "provider_track_failed", fields);
      expect(logger).toHaveBeenCalledWith({
        event: "provider_track_failed",
        actorId: "actor",
        participantId: "participant",
        generation: 2,
        operationId: "operation",
        direction: "consumer",
        version: 3,
        providerStatus: 200,
        errorSource: "track",
        providerErrors: [
          { code: "empty_track_error", count: 1 },
          { code: "not_found_track_error", count: 2 },
          { code: "provider_error", count: 100 },
        ],
      });
      expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
    } finally {
      logger.mockRestore();
    }
  });

  it("keeps a throwing sink from changing operation or closure behavior", () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("private");
    });
    try {
      expect(() =>
        logEvent(
          "warn",
          "media_operation_failed",
          { operation: "subscribe" },
          new RealtimeError("partial_subscription", 502, false, true),
        ),
      ).not.toThrow();
      expect(() =>
        logEvent("warn", "media_participant_closed", {
          closureReason: "removed",
          terminalUpgrade: true,
        }),
      ).not.toThrow();
    } finally {
      logger.mockRestore();
    }
  });
});
