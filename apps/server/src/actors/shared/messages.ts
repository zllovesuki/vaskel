import type { NotificationMessageReference } from "@/server/notifications/protocol";
import type { CommitHint } from "./event-notices";
import type { Kysely } from "kysely";
import {
  DELETED_PAYLOAD_RETENTION_MS,
  type MessagingFailure,
  type MessagingOutcome,
  type QuoteSnapshot,
  type Receipt,
  type SendMessage,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase, MessageRow } from "./database";
import {
  admitMessageCommand,
  messageCommandHash,
  type MessageMutation,
} from "./message-command";
import { RECEIPT_RETENTION_MS, retentionWake } from "./retention";
import { scheduleAlarm } from "./alarms";
import { newSendFailure } from "./send-policy";
import { growthCapacityFailure } from "./capacity";
import { captureQuoteInTransaction, sameQuoteReference } from "./quotes";
import { reactToMessage, replaceMentions } from "./timeline-content";
import { indexSearchMessages, removeSearchMessage } from "./search-index";
import {
  attachmentsForSend,
  claimAttachments,
  retireAttachment,
} from "./attachments/state";

export const EVENT_RETENTION = 1_000;

/** Cross-owner capture needs current target admission and receipt recovery before source I/O. */
export async function prepareSend(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: SendMessage,
  budgetBytes: number,
): Promise<
  | MessagingFailure
  | { kind: "accepted"; receipt: Receipt }
  | { kind: "send_admitted" }
> {
  const mutation = { kind: "send" as const, command };
  const payloadHash = await messageCommandHash(mutation);
  return storage.transaction(async () => {
    const authorized = await admitMessageCommand(
      database,
      principal,
      mutation,
      payloadHash,
    );
    if (authorized.kind !== "authorized") return authorized;
    return (
      (await newSendFailure(database, authorized.state)) ??
      (await growthCapacityFailure(storage, database, budgetBytes)) ?? {
        kind: "send_admitted",
      }
    );
  });
}

export type MessageMutationOutcome =
  | MessagingOutcome
  | {
      kind: "committed";
      receipt: Receipt;
      notice: CommitHint;
      notification?: Omit<NotificationMessageReference, "senderLabel">;
    };

export async function mutateMessage(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  mutation: MessageMutation,
  budgetBytes: number,
): Promise<MessageMutationOutcome> {
  const { kind: operation, command } = mutation;
  const payloadHash = await messageCommandHash(mutation);
  return storage.transaction(async () => {
    const now = Date.now();
    const authorized = await admitMessageCommand(
      database,
      principal,
      mutation,
      payloadHash,
    );
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    const sequence = state.high_water + 1;
    let message: MessageRow;
    let quoteAuthorId: string | undefined;
    let eventOperation: "send" | "edit" | "delete" =
      operation === "remove_attachment" || operation === "react"
        ? "edit"
        : operation;
    if (mutation.kind === "send") {
      const command = mutation.command;
      const blocked = await newSendFailure(database, state);
      if (blocked) return blocked;
      let quote: QuoteSnapshot | undefined;
      if (
        mutation.capturedQuote &&
        (!command.quote ||
          !sameQuoteReference(command.quote, mutation.capturedQuote.selected))
      )
        return { kind: "invalid_input" };
      if (command.quote) {
        if (
          command.quote.owner.kind === state.owner_kind &&
          command.quote.owner.id === state.owner_id
        ) {
          const captured = await captureQuoteInTransaction(
            database,
            principal,
            command.quote,
          );
          if (captured.kind !== "quote_captured") return captured;
          quote = captured.capture.snapshot;
        } else {
          if (!mutation.capturedQuote) return { kind: "source_unavailable" };
          quote = mutation.capturedQuote.snapshot;
        }
      }
      quoteAuthorId = quote?.authorId;
      const files = await attachmentsForSend(
        database,
        principal,
        command.channelId,
        state.generation,
        command.attachmentIds ?? [],
        now,
      );
      if (!Array.isArray(files)) return files;
      if (!command.body.trim() && files.length === 0 && !quote)
        return { kind: "invalid_input" };
      const full = await growthCapacityFailure(storage, database, budgetBytes);
      if (full) return full;
      message = {
        id: crypto.randomUUID(),
        channel_id: command.channelId,
        author_id: principal.userId,
        body: command.body,
        version: 1,
        created_sequence: sequence,
        updated_sequence: sequence,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        quote_json: quote ? JSON.stringify(quote) : null,
      };
      await database.insertInto("messages").values(message).execute();
      await claimAttachments(database, files, message.id);
    } else if (mutation.kind === "react") {
      if (mutation.command.on) {
        const full = await growthCapacityFailure(
          storage,
          database,
          budgetBytes,
        );
        if (full) return full;
      }
      const reacted = await reactToMessage(
        database,
        principal.userId,
        mutation.command,
        sequence,
        now,
      );
      if ("kind" in reacted) return reacted;
      message = reacted;
    } else {
      const { command, kind: operation } = mutation;
      const existing = await database
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", command.messageId)
        .where("channel_id", "=", command.channelId)
        .executeTakeFirst();
      if (!existing)
        return {
          kind:
            operation === "remove_attachment"
              ? "message_unavailable"
              : "not_found",
        };
      const canModerate =
        operation === "delete" &&
        state.owner_kind === "server" &&
        (authorized.member.role === "owner" ||
          authorized.member.role === "moderator");
      if (existing.author_id !== principal.userId && !canModerate)
        return { kind: "forbidden" };
      if (existing.version !== command.expectedVersion)
        return { kind: "stale_version", currentVersion: existing.version };
      if (existing.deleted_at !== null)
        return {
          kind:
            operation === "remove_attachment"
              ? "message_unavailable"
              : "not_found",
        };
      const files = await database
        .selectFrom("attachments")
        .selectAll()
        .where("message_id", "=", existing.id)
        .where("state", "=", "claimed")
        .execute();
      if (
        operation === "edit" &&
        !command.body.trim() &&
        files.length === 0 &&
        existing.quote_json === null
      )
        return { kind: "invalid_input" };
      if (operation === "edit") {
        const full = await growthCapacityFailure(
          storage,
          database,
          budgetBytes,
        );
        if (full) return full;
      }
      const removed =
        operation === "remove_attachment"
          ? files.find((file) => file.id === command.fileId)
          : undefined;
      if (operation === "remove_attachment" && !removed)
        return { kind: "message_unavailable" };
      const deleting =
        operation === "delete" ||
        (operation === "remove_attachment" &&
          files.length === 1 &&
          !existing.body?.trim() &&
          existing.quote_json === null);
      if (deleting) eventOperation = "delete";
      if (deleting || removed) {
        for (const file of deleting ? files : [removed!]) {
          await retireAttachment(
            storage,
            database,
            file,
            now + DELETED_PAYLOAD_RETENTION_MS,
          );
          // A detached file has no live reference. Preserve its row/hold/bytes until GC.
          if (!deleting)
            await database
              .updateTable("attachments")
              .set({ message_id: null, ordinal: null })
              .where("id", "=", file.id)
              .execute();
        }
      }
      if (deleting && (existing.body !== null || existing.quote_json !== null))
        await database
          .insertInto("deleted_payloads")
          .values({
            message_id: existing.id,
            body: existing.body ?? "",
            quote_json: existing.quote_json,
            eligible_at: now + DELETED_PAYLOAD_RETENTION_MS,
          })
          .execute();
      const body = deleting
        ? null
        : operation === "edit"
          ? command.body
          : existing.body;
      message = {
        ...existing,
        body,
        version: existing.version + 1,
        updated_sequence: sequence,
        updated_at: now,
        deleted_at: deleting ? now : null,
        quote_json: deleting ? null : existing.quote_json,
      };
      await database
        .updateTable("messages")
        .set({
          body: message.body,
          version: message.version,
          updated_sequence: sequence,
          updated_at: now,
          deleted_at: message.deleted_at,
          quote_json: message.quote_json,
        })
        .where("id", "=", existing.id)
        .execute();
      await removeSearchMessage(database, message);
    }
    const mentioned =
      operation === "send" || operation === "edit"
        ? await replaceMentions(database, message)
        : [];
    if (eventOperation === "delete") {
      await database
        .deleteFrom("mentions")
        .where("message_id", "=", message.id)
        .execute();
      await database
        .deleteFrom("reactions")
        .where("message_id", "=", message.id)
        .execute();
    }
    await database
      .updateTable("owner_state")
      .set({
        high_water: sequence,
        replay_floor: Math.max(state.replay_floor, sequence - EVENT_RETENTION),
      })
      .where("id", "=", 1)
      .execute();
    if (message.body !== null && operation !== "react")
      await indexSearchMessages(database, [message]);
    const progress = await database
      .selectFrom("channel_progress")
      .select("last_sequence")
      .where("channel_id", "=", command.channelId)
      .executeTakeFirst();
    await database
      .insertInto("channel_progress")
      .values({ channel_id: command.channelId, last_sequence: sequence })
      .onConflict((conflict) =>
        conflict.column("channel_id").doUpdateSet({ last_sequence: sequence }),
      )
      .execute();
    await database
      .insertInto("events")
      .values({
        sequence,
        previous_sequence: progress?.last_sequence ?? 0,
        channel_id: command.channelId,
        operation: eventOperation,
        message_id: message.id,
      })
      .execute();
    await database
      .insertInto("command_receipts")
      .values({
        user_id: principal.userId,
        operation,
        command_id: command.commandId,
        payload_hash: payloadHash,
        message_id: message.id,
        sequence,
        version: message.version,
        issued_at: command.issuedAt,
        accepted_at: now,
      })
      .execute();
    await database
      .deleteFrom("events")
      .where("sequence", "<=", sequence - EVENT_RETENTION)
      .execute();
    await scheduleAlarm(storage, retentionWake(now, RECEIPT_RETENTION_MS));
    if (eventOperation === "delete" || operation === "remove_attachment")
      await scheduleAlarm(storage, now + DELETED_PAYLOAD_RETENTION_MS);
    return {
      kind: "committed",
      receipt: { messageId: message.id, sequence, version: message.version },
      ...(operation === "send"
        ? {
            notification: {
              owner: { kind: state.owner_kind, id: state.owner_id },
              ownerGeneration: state.generation,
              roomId: message.channel_id,
              messageId: message.id,
              sequence: message.created_sequence,
              createdAt: message.created_at,
            },
          }
        : {}),
      notice: {
        owner: { kind: state.owner_kind, id: state.owner_id },
        channelId: message.channel_id,
        generation: state.generation,
        sequence,
        ...(eventOperation === "send"
          ? {
              type: "activity" as const,
              authorId: message.author_id,
              mentioned,
              quoteAuthorId,
            }
          : { type: "mutation" as const }),
      },
    };
  });
}
