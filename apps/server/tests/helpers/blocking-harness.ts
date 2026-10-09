import { env } from "cloudflare:workers";
import { BlockOutcomeSchema } from "@vaskel/contracts/blocking";
import { directConversationId } from "@/server/directory/identifiers";
import type { Principal } from "@/server/domain/principal";

export const blockCommand = (blocked = true, expectedRevision = 0) => ({
  commandId: crypto.randomUUID(),
  issuedAt: Date.now(),
  blocked,
  expectedRevision,
});
export const pairPrincipal = (userId = crypto.randomUUID()): Principal => ({
  userId,
  sessionId: `session-${userId}`,
  expiresAt: Date.now() + 60_000,
});
export async function blockingPair(initialize = true) {
  const alice = pairPrincipal();
  const bob = pairPrincipal();
  const id = await directConversationId(alice.userId, bob.userId);
  const owner = env.CONVERSATION_DO.getByName(id);
  if (initialize)
    await owner.initialize({
      conversationId: id,
      participantIds: [alice.userId, bob.userId],
    });
  const send = (
    body = "東京都 retained history",
    attachmentIds: string[] = [],
  ) => ({
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    channelId: id,
    body,
    attachmentIds,
  });
  const reserveCommand = () => ({
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    channelId: id,
    filename: "private.txt",
    byteLength: 3,
  });
  const reserve = async () => {
    const command = reserveCommand();
    const result = await owner.reserveAttachment(alice, command);
    if (result.kind !== "attachment_reserved") throw new Error(result.kind);
    return { ...result, command };
  };
  return { alice, bob, id, owner, send, reserve, reserveCommand };
}
export function blockResult(result: unknown) {
  const parsed = BlockOutcomeSchema.parse(result);
  if (parsed.kind !== "block_updated")
    throw new Error(`Expected block_updated: ${parsed.kind}`);
  return parsed;
}
