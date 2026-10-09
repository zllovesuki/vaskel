import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  MediaOutcomeSchema,
  type MediaHandle,
  type MediaSnapshot,
  type MediaRoomRef,
  type JoinMediaRequest,
  type MediaSource,
} from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import {
  mediaRoomKey,
  type MediaAuthorization,
} from "@/server/media/authorization";
import { createMediaSfu } from "@tests/fixtures/media-sfu";
import { useMediaSfu } from "@tests/helpers/media-network";

export function user(): Principal {
  const userId = crypto.randomUUID();
  return {
    userId,
    sessionId: crypto.randomUUID(),
    expiresAt: Date.now() + 60_000,
  };
}
export function room(): MediaRoomRef {
  return {
    owner: { kind: "server", id: crypto.randomUUID() },
    channelId: crypto.randomUUID(),
  };
}
export function grant(
  principal: Principal,
  scope: MediaRoomRef,
  generation = 1,
): MediaAuthorization {
  return {
    room: scope,
    userId: principal.userId,
    sessionId: principal.sessionId,
    permissionGeneration: generation,
    expiresAt: Date.now() + 30_000,
    canJoin: true,
    canSpeak: true,
    canCamera: true,
    canScreen: true,
    canModerate: true,
  };
}
export function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function request(
  scope: MediaRoomRef,
  expectedGeneration = 0,
): JoinMediaRequest {
  return {
    room: scope,
    clientId: crypto.randomUUID(),
    deviceToken: token(),
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedGeneration,
  };
}
export function setup() {
  const fake = createMediaSfu();
  useMediaSfu(fake);
  const principal = user(),
    scope = room();
  const account = env.ACCOUNT_MEDIA.getByName(principal.userId);
  const media = env.MEDIA_ROOM.getByName(mediaRoomKey(scope));
  return { fake, principal, scope, account, media };
}
export function joined(outcome: unknown) {
  const parsed = MediaOutcomeSchema.parse(outcome);
  if (parsed.kind !== "joined")
    throw new Error(`Expected joined, got ${JSON.stringify(parsed)}`);
  return parsed;
}
export function offer(sources: MediaSource[]) {
  return {
    type: "offer" as const,
    sdp:
      "v=0\r\n" +
      sources
        .map(
          (source, index) =>
            `m=${source === "microphone" || source === "screen_audio" ? "audio" : "video"} 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:${index}\r\n`,
        )
        .join(""),
  };
}
export function publication(
  handle: MediaHandle,
  sources: MediaSource[] = ["microphone"],
  expectedSessionVersion = 0,
) {
  return {
    handle,
    operationId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedSessionVersion,
    sessionDescription: offer(sources),
    tracks: sources.map((source, index) => ({ source, mid: String(index) })),
  };
}
export async function publishReady(
  s: ReturnType<typeof setup>,
  handle: MediaHandle,
  sources: MediaSource[] = ["microphone"],
  permissionGeneration = 1,
) {
  const result = MediaOutcomeSchema.parse(
    await s.media.publish(
      s.principal,
      grant(s.principal, s.scope, permissionGeneration),
      publication(handle, sources),
    ),
  );
  if (result.kind !== "negotiation")
    throw new Error(`Expected negotiation, got ${result.kind}`);
  expect(
    await s.media.ack(
      s.principal,
      grant(s.principal, s.scope, permissionGeneration),
      {
        handle,
        operationId: result.operationId,
        expectedSessionVersion: result.sessionVersion,
      },
    ),
  ).toMatchObject({ kind: "completed" });
  return result;
}

/** Build a control from the participant shown in a captured roster. */
export function moderationTarget(snapshot: MediaSnapshot, userId: string) {
  const participant = snapshot.participants.find((p) => p.userId === userId);
  if (!participant) throw new Error("Missing displayed moderation target");
  return {
    participantGeneration: participant.generation,
    expectedControlVersion: participant.controlVersion,
  };
}
