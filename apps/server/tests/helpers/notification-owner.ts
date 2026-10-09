import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OwnerScope, QuoteReference } from "@vaskel/contracts/messaging";
import type {
  NotificationMessageReference,
  NotificationMessageQuery,
} from "@/server/notifications/protocol";
import {
  messageEnvelope as command,
  acceptedMessage as receipt,
} from "@tests/helpers/messaging";
import { principal } from "@tests/helpers/messaging-owner";
import type { MessageDO } from "@/server/actors/shared/message-do";

export async function notificationOwner(kind: OwnerScope["kind"] = "server") {
  const id = crypto.randomUUID();
  const owner: DurableObjectStub<MessageDO> =
    kind === "server"
      ? env.SERVER_DO.getByName(id)
      : env.CONVERSATION_DO.getByName(id);
  let channelId: string;
  if (kind === "server") {
    const result = await env.SERVER_DO.getByName(id).initialize({
      serverId: id,
      name: "Circle",
      ownerId: "alice",
    });
    if (result.kind !== "initialized") throw new Error(result.kind);
    channelId = result.channelId;
    await runInDurableObject(owner, async (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES ('bob','member'),('carol','member')",
      );
    });
  } else {
    await env.CONVERSATION_DO.getByName(id).initialize({
      conversationId: id,
      participantIds: ["alice", "bob"],
    });
    channelId = id;
  }
  const send = async (
    body: string,
    author = "alice",
    quote?: QuoteReference,
  ) => {
    const sent = receipt(
      (
        await owner.send(
          principal(author),
          { ...command(channelId), body, ...(quote ? { quote } : {}) },
          undefined,
          author,
        )
      ).outcome,
    );
    const original = await owner.originalMessage(principal(author), {
      channelId,
      messageId: sent.messageId,
    });
    const snapshot = await owner.snapshot(principal(author), { channelId });
    if (original.kind !== "original_message" || snapshot.kind !== "snapshot")
      throw new Error("fixture missing message");
    return {
      owner: { kind, id },
      ownerGeneration: snapshot.cursor.generation,
      roomId: channelId,
      messageId: sent.messageId,
      sequence: sent.sequence,
      createdAt: original.message.createdAt,
      senderLabel: author,
    } satisfies NotificationMessageReference;
  };
  const resolve = (
    accountId: string,
    references: NotificationMessageReference[],
    query: NotificationMessageQuery = { directOnly: false, includeText: true },
  ) => owner.selectNotificationMessage(accountId, references, query);
  return { id, channelId, owner, send, resolve };
}
