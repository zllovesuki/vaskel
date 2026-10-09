import { describe, expect, it, vi } from "vitest";
import {
  isAbsentSession,
  isAbsentTrack,
  RealtimeClient,
  RealtimeError,
} from "@/server/providers/realtime";

const configuredEnv = {
  REALTIME_APP_ID: "app/id",
  REALTIME_APP_SECRET: "test-secret",
};

function clientFor(payload: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json(payload, { status }),
  );
  return { client: new RealtimeClient(configuredEnv, fetcher), fetcher };
}

describe("bounded raw Realtime provider", () => {
  it("constructs a native workerd Request and refuses provider redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect === "manual").toBe(true);
      // Empty sessions accept a bodyless POST; an empty JSON object is rejected live.
      expect(await request.text()).toBe("");
      expect(request.headers.has("content-type")).toBe(false);
      expect(
        request.headers.get("authorization") === "Bearer test-secret",
      ).toBe(true);
      return Response.json({ sessionId: "native-request" }, { status: 201 });
    });
    const client = new RealtimeClient(configuredEnv, fetcher);
    await expect(client.createSession()).resolves.toEqual({
      sessionId: "native-request",
    });
    fetcher.mockImplementation(async (input, init) => {
      new Request(input, init);
      return Response.json(
        {},
        {
          status: 302,
          headers: { location: "https://example.invalid/forbidden-redirect" },
        },
      );
    });
    await expect(client.createSession()).rejects.toMatchObject({
      code: "unexpected_status",
      status: 302,
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows the default client to intercept only external fetch in workerd", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe(
          "https://rtc.live.cloudflare.com/v1/apps/app%2Fid/sessions/new",
        );
        return Response.json({ sessionId: "mocked-external" }, { status: 201 });
      });
    try {
      await expect(
        new RealtimeClient(configuredEnv).createSession(),
      ).resolves.toEqual({ sessionId: "mocked-external" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("fails closed before fetch when either binding is missing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const env of [
      { REALTIME_APP_ID: "app" },
      { REALTIME_APP_ID: " ", REALTIME_APP_SECRET: "test" },
    ]) {
      const client = new RealtimeClient(env, fetcher);
      expect(client.configured).toBe(false);
      await expect(client.createSession()).rejects.toMatchObject({
        code: "unavailable",
        status: 503,
        retryable: false,
        uncertain: false,
      });
      await expect(client.closeTracks("session", [])).rejects.toMatchObject({
        code: "unavailable",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses fixed encoded paths, correct verbs, server authorization and forced closure", async () => {
    const { client, fetcher } = clientFor({ sessionId: "allocated" }, 201);
    expect(client.configured).toBe(true);
    await expect(client.createSession()).resolves.toEqual({
      sessionId: "allocated",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://rtc.live.cloudflare.com/v1/apps/app%2Fid/sessions/new",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
        },
        redirect: "manual",
      }),
    );
    expect(fetcher.mock.calls.at(-1)?.[1]?.body).toBeUndefined();
    fetcher.mockImplementation(async () => Response.json({}));
    const offer = { type: "offer" as const, sdp: "complete offer" };
    const tracks = [
      {
        location: "local" as const,
        mid: "0",
        trackName: "microphone",
        kind: "audio" as const,
      },
    ];
    await client.addTracks("session/id", { sessionDescription: offer, tracks });
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("/sessions/session%2Fid/tracks/new"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionDescription: offer, tracks }),
      }),
    );
    const answer = { type: "answer" as const, sdp: "complete answer" };
    await expect(client.renegotiate("session/id", answer)).resolves.toEqual({
      tracks: [],
      requiresImmediateRenegotiation: false,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("/sessions/session%2Fid/renegotiate"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ sessionDescription: answer }),
      }),
    );
    await client.closeTracks("session/id", ["0", "1"]);
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("/sessions/session%2Fid/tracks/close"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          force: true,
          tracks: [{ mid: "0" }, { mid: "1" }],
        }),
      }),
    );
    fetcher.mockImplementation(async () =>
      Response.json({ tracks: [{ mid: "0", status: "waiting" }] }),
    );
    await expect(client.getSession("session/id")).resolves.toEqual({
      tracks: [{ mid: "0", status: "waiting" }],
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://rtc.live.cloudflare.com/v1/apps/app%2Fid/sessions/session%2Fid",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher.mock.calls.at(-1)?.[1]).not.toHaveProperty("body");
  });

  it("normalizes omitted provider result arrays and negotiation flags", async () => {
    const { client } = clientFor({});
    await expect(client.closeTracks("session", ["0"])).resolves.toEqual({
      tracks: [],
      requiresImmediateRenegotiation: false,
    });
    await expect(client.getSession("session")).resolves.toEqual({ tracks: [] });
  });

  it("bounds fetch headers even when the injected fetcher ignores AbortSignal", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const client = new RealtimeClient(configuredEnv, fetcher, {
      timeoutMs: 20,
    });
    await expect(client.createSession()).rejects.toMatchObject({
      code: "timeout",
      status: 504,
      retryable: true,
      uncertain: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("keeps the deadline running through a hanging streamed body and cancels it", async () => {
    const canceled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"tracks":'));
            },
            cancel: canceled,
          }),
        ),
    );
    const client = new RealtimeClient(configuredEnv, fetcher, {
      timeoutMs: 20,
    });
    await expect(client.closeTracks("session", ["0"])).rejects.toMatchObject({
      code: "timeout",
      uncertain: true,
    });
    expect(canceled).toHaveBeenCalledTimes(1);
    await expect(client.getSession("session")).rejects.toMatchObject({
      code: "timeout",
      uncertain: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a streamed response over the byte cap without relying on content-length", async () => {
    const canceled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"tracks":[],'));
              controller.enqueue(new Uint8Array(32));
            },
            cancel: canceled,
          }),
        ),
    );
    const client = new RealtimeClient(configuredEnv, fetcher, {
      maxResponseBytes: 32,
    });
    await expect(
      client.addTracks("session", { tracks: [] }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
      uncertain: true,
    });
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized declared bodies before reading", async () => {
    const canceled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ cancel: canceled }), {
          headers: { "content-length": "1000" },
        }),
    );
    await expect(
      new RealtimeClient(configuredEnv, fetcher, {
        maxResponseBytes: 32,
      }).getSession("session"),
    ).rejects.toMatchObject({ code: "invalid_response", uncertain: false });
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    { tracks: "bad" },
    { tracks: [{ mid: 2 }] },
    { tracks: [{ errorCode: 2 }] },
    { sessionDescription: { type: "rollback", sdp: "bad" } },
    { requiresImmediateRenegotiation: "true" },
  ])("rejects malformed provider fields %j", async (payload) => {
    await expect(
      clientFor(payload).client.addTracks("session", { tracks: [] }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
      uncertain: true,
    });
  });

  it("requires HTTP 201 and a nonempty session identifier for creation", async () => {
    await expect(
      clientFor({ sessionId: "session" }).client.createSession(),
    ).rejects.toMatchObject({ code: "unexpected_status", status: 200 });
    await expect(
      clientFor({ sessionId: "" }, 201).client.createSession(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    new TextEncoder().encode("invalid JSON"),
    new Uint8Array([0xff]),
    new Uint8Array([0xc2]),
  ])("rejects malformed JSON and UTF-8 bytes", async (bytes) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
    await expect(
      new RealtimeClient(configuredEnv, fetcher).getSession("session"),
    ).rejects.toMatchObject({ code: "invalid_response", uncertain: false });
  });

  it("validates public session state status fields", async () => {
    await expect(
      clientFor({
        tracks: [{ mid: "0", status: "connected" }],
      }).client.getSession("session"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([401, 503])(
    "treats unauthorized configuration as permanent under HTTP %i",
    async (status) => {
      const { client } = clientFor(
        {
          errorCode: "unauthorized",
          errorDescription: "secret app-specific upstream diagnostic",
        },
        status,
      );
      let caught: unknown;
      try {
        await client.createSession();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RealtimeError);
      expect(caught).toMatchObject({
        code: "unauthorized",
        status,
        retryable: false,
        uncertain: false,
      });
      expect(String(caught)).not.toContain("secret app-specific");
      expect(caught).not.toHaveProperty("errorDescription");
    },
  );

  it("throws sanitized top-level errors even under HTTP 200", async () => {
    await expect(
      clientFor({
        errorCode: "invalid_params",
        errorDescription: "private",
        tracks: [{ mid: "0" }],
      }).client.addTracks("session", { tracks: [] }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      status: 200,
      retryable: false,
    });
    await expect(
      clientFor(
        {
          errorCode: "credential: dangerous value",
          errorDescription: "private",
        },
        503,
      ).client.getSession("session"),
    ).rejects.toMatchObject({ code: "provider_error", retryable: false });
  });

  it.each([
    ["retryable_transient_error", 503, true],
    ["temporarily_unavailable_error", 503, true],
    ["invalid_params", 503, false],
    ["session_error", 425, true],
    ["session_error", 410, false],
    ["internal_error", 500, false],
    ["not_found", 404, false],
  ])(
    "classifies public %s at HTTP %i conservatively",
    async (code, status, retryable) => {
      await expect(
        clientFor({ errorCode: code }, status).client.getSession("session"),
      ).rejects.toMatchObject({ code, status, retryable });
    },
  );

  it("recognizes only explicit session and close-track absence", async () => {
    const errors: unknown[] = [];
    for (const [code, status] of [
      ["session_error", 410],
      ["not_found", 404],
      ["session_error", 404],
      ["unauthorized", 410],
    ] as const) {
      try {
        await clientFor({ errorCode: code }, status).client.closeTracks(
          "session",
          ["0"],
        );
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors.map(isAbsentSession)).toEqual([true, false, false, false]);
    expect(isAbsentSession({ status: 410, code: "session_error" })).toBe(false);
    expect(isAbsentTrack({ errorCode: "close_track_error" })).toBe(true);
    expect(isAbsentTrack({ errorCode: "not_found_track_error" })).toBe(false);
    expect(isAbsentTrack({ errorDescription: "already closed" })).toBe(false);
  });

  it("does not propagate raw network errors or automatically retry mutations", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("sensitive network diagnostic");
    });
    const client = new RealtimeClient(configuredEnv, fetcher);
    await expect(client.createSession()).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
      uncertain: true,
    });
    await expect(client.getSession("session")).rejects.toMatchObject({
      code: "network_error",
      uncertain: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Realtime diagnostics preserve failure semantics", () => {
  const context = {
    actorId: "actor",
    participantId: "participant",
    generation: 2,
    operationId: "operation",
    direction: "consumer" as const,
    version: 3,
  };

  it("distinguishes top-level HTTP 200 errors and malformed HTTP 410 bodies from synthetic errors", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        clientFor({
          errorCode: "session_error",
          errorDescription: "private",
        }).client.addTracks("private-session", { tracks: [] }, context),
      ).rejects.toMatchObject({ status: 200, uncertain: false });
      expect(logger).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: "provider_request_failed",
          ...context,
          operation: "add_tracks",
          providerStatus: 200,
          errorSource: "top_level",
          code: "session_error",
          retryable: false,
          uncertain: false,
        }),
      );
      const client = new RealtimeClient(
        configuredEnv,
        async () => new Response("private malformed", { status: 410 }),
      );
      await expect(
        client.getSession("private-session", {
          ...context,
          cleanup: "session",
        }),
      ).rejects.toMatchObject({ status: 502, code: "invalid_response" });
      expect(logger).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerStatus: 410,
          errorSource: "response",
          code: "invalid_response",
        }),
      );
      expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
    } finally {
      logger.mockRestore();
    }
  });

  it("logs active absence and suppresses only absence recognized by explicit cleanup", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client } = clientFor({ errorCode: "session_error" }, 410);
      await expect(client.getSession("session", context)).rejects.toMatchObject(
        { status: 410 },
      );
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenLastCalledWith(
        expect.objectContaining({ providerStatus: 410, code: "session_error" }),
      );
      await expect(
        client.getSession("session", { ...context, cleanup: "session" }),
      ).rejects.toMatchObject({ status: 410 });
      await expect(
        client.closeTracks("session", ["0"], {
          ...context,
          cleanup: "session",
        }),
      ).rejects.toMatchObject({ status: 410 });
      expect(logger).toHaveBeenCalledTimes(1);
      await expect(
        client.addTracks(
          "session",
          { tracks: [] },
          { ...context, cleanup: "session" },
        ),
      ).rejects.toMatchObject({ status: 410 });
      expect(logger).toHaveBeenCalledTimes(2);
      const absent = clientFor({
        tracks: [{ mid: "0", errorCode: "close_track_error" }],
      }).client;
      await absent.closeTracks("session", ["0"], context);
      expect(logger).toHaveBeenCalledTimes(3);
      await absent.closeTracks("session", ["0"], {
        ...context,
        cleanup: "session",
      });
      expect(logger).toHaveBeenCalledTimes(3);
      const unknown = clientFor({ errorCode: "not_found" }, 404).client;
      await expect(
        unknown.getSession("session", { ...context, cleanup: "session" }),
      ).rejects.toMatchObject({ status: 404 });
      expect(logger).toHaveBeenCalledTimes(4);
    } finally {
      logger.mockRestore();
    }
  });

  it("logs absent sessions during track-only closure while accepting explicitly absent tracks", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const closure = { ...context, cleanup: "tracks" as const };
    try {
      await expect(
        clientFor({ errorCode: "session_error" }, 410).client.closeTracks(
          "private-session",
          ["private-mid"],
          closure,
        ),
      ).rejects.toMatchObject({
        code: "session_error",
        status: 410,
        retryable: false,
        uncertain: false,
      });
      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "provider_request_failed",
          ...closure,
          operation: "close_tracks",
          providerStatus: 410,
          errorSource: "top_level",
          code: "session_error",
        }),
      );
      const tracks = [{ mid: "private-mid", errorCode: "close_track_error" }];
      await expect(
        clientFor({ tracks }).client.closeTracks(
          "private-session",
          ["private-mid"],
          closure,
        ),
      ).resolves.toMatchObject({ tracks });
      expect(logger).toHaveBeenCalledTimes(1);
      await expect(
        clientFor({ errorCode: "session_error" }, 410).client.getSession(
          "private-session",
          closure,
        ),
      ).rejects.toMatchObject({ code: "session_error", status: 410 });
      expect(logger).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
    } finally {
      logger.mockRestore();
    }
  });

  it("keeps mixed successes intact while logging bounded item codes before actor collapse", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tracks = [
        {
          mid: "private-mid",
          trackName: "private-track",
          sessionId: "private-session",
          location: "local",
          kind: "audio",
        },
        {
          trackName: "private-camera",
          errorCode: "empty_track_error",
          errorDescription: "private",
        },
        { errorCode: "not_found_track_error", errorDescription: "private" },
        { errorCode: "private_unknown", errorDescription: "private" },
        { errorDescription: "private" },
      ];
      const response = {
        tracks,
        sessionDescription: { type: "offer", sdp: "private-offer" },
        requiresImmediateRenegotiation: true,
      };
      const result = await clientFor(response).client.addTracks(
        "private-session",
        { tracks: [] },
        context,
      );
      expect(result).toEqual(response);
      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "provider_track_failed",
          ...context,
          providerStatus: 200,
          errorSource: "track",
          processed: 5,
          succeeded: 1,
          failed: 4,
          providerErrors: [
            { code: "empty_track_error", count: 1 },
            { code: "not_found_track_error", count: 1 },
            { code: "provider_error", count: 2 },
          ],
        }),
      );
      expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
    } finally {
      logger.mockRestore();
    }
  });

  it("snapshots concurrent per-operation correlation and tolerates a throwing log sink", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ errorCode: "invalid_params" }));
    const client = new RealtimeClient(configuredEnv, fetcher);
    const firstContext = { ...context, operationId: "first" };
    const first = client.getSession("private-first", firstContext);
    const rejected = expect(first).rejects.toMatchObject({
      code: "session_error",
    });
    firstContext.operationId = "private-mutated";
    try {
      await expect(
        client.getSession("private-second", {
          ...context,
          operationId: "second",
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
      release(Response.json({ errorCode: "session_error" }, { status: 410 }));
      await rejected;
      expect(logger.mock.calls.map(([entry]) => entry.operationId)).toEqual([
        "second",
        "first",
      ]);
      logger.mockImplementation(() => {
        throw new Error("private-sink");
      });
      const mixed = clientFor({
        tracks: [{ mid: "0" }, { errorCode: "empty_track_error" }],
      }).client;
      await expect(
        mixed.addTracks("session", { tracks: [] }, context),
      ).resolves.toMatchObject({
        tracks: [{ mid: "0" }, { errorCode: "empty_track_error" }],
      });
      await expect(
        clientFor({ errorCode: "session_error" }, 410).client.getSession(
          "session",
          context,
        ),
      ).rejects.toMatchObject({ status: 410, code: "session_error" });
    } finally {
      logger.mockRestore();
    }
  });
});
