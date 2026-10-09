import { nativeSocket } from "@tests/helpers/native-socket";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  MessagingOutcomeSchema,
  type MessagingOutcome,
  type ReplayCursor,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";

export function principal(userId: string): Principal {
  return {
    userId,
    sessionId: `session-${userId}`,
    expiresAt: Date.now() + 60 * 60 * 1_000,
  };
}

export const alice = () => principal("alice");

export const bob = () => principal("bob");

export const carol = () => principal("carol");

export async function server(name = "Server") {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  expect(
    await owner.initialize({ serverId: id, name, ownerId: "alice" }),
  ).toMatchObject({ kind: "initialized", channelId: id });
  return { id, owner };
}

export function send(
  channelId: string,
  body = "今日は東京都で会話。数据库设计 데이터베이스",
) {
  return {
    channelId,
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    body,
  };
}

export async function inviteMember(
  owner: Awaited<ReturnType<typeof server>>["owner"],
  member = bob(),
) {
  const invitation = await owner.createInvite(
    { ...alice(), invitePolicy: "members" },
    {
      expiresAt: Date.now() + 60 * 60 * 1_000,
      maxUses: 3,
    },
  );
  if (invitation.kind !== "invite_created") throw new Error("Expected invite");
  expect(
    await owner.redeemInvite(member, { token: invitation.token }),
  ).toMatchObject({ kind: "joined" });
  return invitation;
}

export async function snapshotCursor(
  owner: Awaited<ReturnType<typeof server>>["owner"],
  channelId: string,
): Promise<ReplayCursor> {
  const snapshot = MessagingOutcomeSchema.parse(
    await owner.snapshot(alice(), { channelId }),
  );
  if (snapshot.kind !== "snapshot") throw new Error("Expected snapshot");
  return snapshot.cursor;
}

export async function socket(
  owner: Awaited<ReturnType<typeof server>>["owner"],
  channelId: string,
  member = alice(),
  ticket?: Extract<MessagingOutcome, { kind: "socket_ticket" }>,
) {
  return nativeSocket(owner, channelId, member, ticket);
}
