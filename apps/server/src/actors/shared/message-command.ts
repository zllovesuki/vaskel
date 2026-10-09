import type { Kysely } from "kysely";
import {
  COMMAND_RETRY_MS,
  type DeleteMessage,
  type EditMessage,
  type MessagingFailure,
  type Receipt,
  type ReactMessage,
  type RemoveMessageAttachment,
  type SendMessage,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { access, type AuthorizedChannel } from "./policy";
import { sha256Hex } from "@/server/auth/crypto";
import type { CapturedQuote } from "./quotes";

/** Commands from the future or older than the retry window are never admitted. */
export function commandWindowFailure(
  issuedAt: number,
  now: number,
): { kind: "command_expired" } | null {
  return issuedAt > now + 30_000 || issuedAt < now - COMMAND_RETRY_MS
    ? { kind: "command_expired" }
    : null;
}

export type MessageMutation =
  | { kind: "send"; command: SendMessage; capturedQuote?: CapturedQuote }
  | { kind: "react"; command: ReactMessage }
  | { kind: "edit"; command: EditMessage }
  | { kind: "delete"; command: DeleteMessage }
  | { kind: "remove_attachment"; command: RemoveMessageAttachment };

/** Canonical receipt identity never depends on RPC object insertion order. */
export function messageCommandHash(mutation: MessageMutation) {
  const { command, kind } = mutation;
  const fields = {
    commandId: command.commandId,
    issuedAt: command.issuedAt,
    channelId: command.channelId,
  };
  const payload =
    kind === "send"
      ? {
          ...fields,
          body: command.body,
          ...((command.attachmentIds?.length ?? 0) > 0
            ? { attachmentIds: command.attachmentIds }
            : {}),
          ...(command.quote
            ? {
                quote: {
                  owner: {
                    kind: command.quote.owner.kind,
                    id: command.quote.owner.id,
                  },
                  channelId: command.quote.channelId,
                  messageId: command.quote.messageId,
                },
              }
            : {}),
        }
      : {
          ...fields,
          messageId: command.messageId,
          ...(kind === "react"
            ? { emoji: command.emoji, on: command.on }
            : { expectedVersion: command.expectedVersion }),
          ...(kind === "edit" ? { body: command.body } : {}),
          ...(kind === "remove_attachment" ? { fileId: command.fileId } : {}),
        };
  return sha256Hex(JSON.stringify(payload));
}

/** Caller holds the native owner transaction. Recovery applies only to new writes. */
export async function admitMessageCommand(
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  mutation: MessageMutation,
  payloadHash: string,
): Promise<
  AuthorizedChannel | MessagingFailure | { kind: "accepted"; receipt: Receipt }
> {
  const { kind: operation, command } = mutation;
  const authorized = await access(database, principal, command.channelId);
  if (authorized.kind !== "authorized") return authorized;
  const expired = commandWindowFailure(command.issuedAt, Date.now());
  if (expired) return expired;
  const previous = await database
    .selectFrom("command_receipts")
    .selectAll()
    .where("user_id", "=", principal.userId)
    .where("operation", "=", operation)
    .where("command_id", "=", command.commandId)
    .executeTakeFirst();
  if (previous)
    return previous.payload_hash === payloadHash
      ? {
          kind: "accepted",
          receipt: {
            messageId: previous.message_id,
            sequence: previous.sequence,
            version: previous.version,
          },
        }
      : { kind: "command_conflict" };
  return authorized;
}
