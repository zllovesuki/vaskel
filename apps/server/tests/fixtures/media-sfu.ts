import { z } from "zod";
import type { TrackResult } from "@/server/providers/realtime";

export type MediaSfuTrack = TrackResult & {
  mid: string;
  trackName: string;
  location: "local" | "remote";
};

export type MediaSfuSession = {
  tracks: Map<string, MediaSfuTrack>;
  createdAt: number;
  connected: boolean;
};
export type MediaSfuCall = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

export type MediaSfu = {
  fetcher: typeof fetch;
  sessions: Map<string, MediaSfuSession>;
  calls: MediaSfuCall[];
  unusedSessionTtlMs: number;
  loseCreateResponse: boolean;
  failClose: boolean;
  partialPublish: boolean;
  createGate?: Promise<void> | undefined;
  publishGate?: Promise<void> | undefined;
  subscribeGate?: Promise<void> | undefined;
  renegotiateGate?: Promise<void> | undefined;
  remoteRequiresRenegotiation: boolean;
};

const tracksRequestSchema = z.object({
  tracks: z.array(
    z.object({
      location: z.enum(["local", "remote"]),
      mid: z.string().optional(),
      trackName: z.string(),
      sessionId: z.string().optional(),
      kind: z.enum(["audio", "video"]).optional(),
    }),
  ),
});
const closeRequestSchema = z.object({
  force: z.literal(true),
  tracks: z.array(z.object({ mid: z.string() })),
});

/** Only the raw external SFU is replaced; vaskel. actors and storage remain real. */
export function createMediaSfu(): MediaSfu {
  let sessionSequence = 0;
  let remoteMidSequence = 0;
  const fake: MediaSfu = {
    sessions: new Map(),
    calls: [],
    unusedSessionTtlMs: Infinity,
    loseCreateResponse: false,
    failClose: false,
    partialPublish: false,
    remoteRequiresRenegotiation: true,
    fetcher: async (input, init) => {
      const requestInit = { ...init };
      delete requestInit.signal;
      const request = new Request(input, requestInit);
      const url = new URL(request.url);
      const appPrefix = "/v1/apps/fixture-app";
      if (
        url.origin !== "https://rtc.live.cloudflare.com" ||
        !url.pathname.startsWith(`${appPrefix}/`) ||
        url.search ||
        url.hash
      ) {
        throw new Error("Unexpected URL in the external SFU fixture.");
      }
      const text = request.body ? await request.text() : "";
      const body = text
        ? z.record(z.string(), z.unknown()).parse(JSON.parse(text))
        : {};
      fake.calls.push({ method: request.method, path: url.pathname, body });
      const route = url.pathname.slice(appPrefix.length);
      if (request.method === "POST" && route === "/sessions/new") {
        if (text)
          return Response.json(
            { errorCode: "decoding_error" },
            { status: 400 },
          );
        await fake.createGate;
        const sessionId = `fixture-session-${++sessionSequence}`;
        fake.sessions.set(sessionId, {
          tracks: new Map(),
          createdAt: Date.now(),
          connected: false,
        });
        if (fake.loseCreateResponse) return Response.json({}, { status: 201 });
        return Response.json({ sessionId }, { status: 201 });
      }
      const match =
        /^\/sessions\/([^/]+)(\/tracks\/new|\/tracks\/close|\/renegotiate)?$/.exec(
          route,
        );
      if (!match?.[1]) throw new Error("Unexpected raw SFU fixture route.");
      const sessionId = decodeURIComponent(match[1]);
      const operation = match[2] ?? "";
      const session = fake.sessions.get(sessionId);
      if (
        !session ||
        (!session.connected &&
          Date.now() - session.createdAt >= fake.unusedSessionTtlMs)
      ) {
        fake.sessions.delete(sessionId);
        return Response.json({ errorCode: "session_error" }, { status: 410 });
      }
      if (request.method === "GET" && operation === "") {
        return Response.json({
          tracks: [...session.tracks.values()].map((track) => ({
            ...track,
            status: "active",
          })),
        });
      }
      if (request.method === "POST" && operation === "/tracks/new") {
        const { tracks } = tracksRequestSchema.parse(body);
        session.connected = true;
        const remote = tracks[0]?.location === "remote";
        if (
          tracks.some(
            (track) => track.location !== (remote ? "remote" : "local"),
          )
        ) {
          throw new Error(
            "The SFU fixture requires one track direction per batch.",
          );
        }
        const allocated = tracks.map((track): MediaSfuTrack => {
          if (track.location === "local" && track.mid === undefined) {
            throw new Error("Local fixture tracks require an offered mid.");
          }
          if (track.location === "remote" && track.sessionId === undefined) {
            throw new Error(
              "Remote fixture tracks require their publisher session.",
            );
          }
          const mid = remote
            ? `fixture-remote-mid-${++remoteMidSequence}`
            : track.mid!;
          const result: MediaSfuTrack = { ...track, mid };
          session.tracks.set(mid, result);
          return result;
        });
        await (remote ? fake.subscribeGate : fake.publishGate);
        return Response.json({
          tracks: allocated.map((track, index) =>
            !remote && fake.partialPublish && index === 1
              ? { ...track, errorCode: "backend_error" }
              : track,
          ),
          sessionDescription: {
            type: remote ? "offer" : "answer",
            sdp: "v=0\r\n",
          },
          requiresImmediateRenegotiation:
            remote && fake.remoteRequiresRenegotiation,
        });
      }
      if (request.method === "PUT" && operation === "/tracks/close") {
        const { tracks } = closeRequestSchema.parse(body);
        return Response.json({
          tracks: tracks.map(({ mid }) => {
            if (!session.tracks.has(mid))
              return { mid, errorCode: "close_track_error" };
            if (fake.failClose) return { mid, errorCode: "backend_error" };
            session.tracks.delete(mid);
            return { mid };
          }),
        });
      }
      if (request.method === "PUT" && operation === "/renegotiate") {
        await fake.renegotiateGate;
        z.object({
          sessionDescription: z.object({
            type: z.literal("answer"),
            sdp: z.string(),
          }),
        }).parse(body);
        return Response.json({});
      }
      throw new Error("Unexpected method in the external SFU fixture.");
    },
  };
  return fake;
}
