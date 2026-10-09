import {
  RECEIPT_RETENTION_MS,
  retentionWake,
} from "@/server/actors/shared/retention";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { type Kysely } from "kysely";
import type {
  BlockFailure,
  BlockOutcome,
  BlockStatus,
  SetBlock,
} from "@vaskel/contracts/blocking";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { commandWindowFailure } from "@/server/actors/shared/message-command";
import {
  access,
  getState,
  principalFailure,
} from "@/server/actors/shared/policy";
import { sha256Hex } from "@/server/auth/crypto";

export interface DirectPair {
  conversationId: string;
  participantIds: [string, string];
}

/** Only called inside the owning actor's native transaction. No directory authority. */
export async function verifyDirectPair(
  database: Kysely<OwnerDatabase>,
  pair: DirectPair,
): Promise<BlockFailure | null> {
  const [first, second] = [...pair.participantIds].sort();
  const existing = await database
    .selectFrom("direct_pair")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  if (
    existing &&
    (existing.conversation_id !== pair.conversationId ||
      existing.first_user_id !== first ||
      existing.second_user_id !== second)
  )
    return { kind: "command_conflict" };
  const state = await getState(database);
  if (state) {
    if (
      state.owner_kind !== "conversation" ||
      state.owner_id !== pair.conversationId
    )
      return { kind: "command_conflict" };
    const members = await database
      .selectFrom("members")
      .select("user_id")
      .orderBy("user_id")
      .execute();
    if (
      members.length !== 2 ||
      members[0]?.user_id !== first ||
      members[1]?.user_id !== second
    )
      return { kind: "command_conflict" };
  }
  return null;
}

async function status(
  database: Kysely<OwnerDatabase>,
  userId: string,
  pair: DirectPair,
): Promise<BlockStatus> {
  const rules = await database
    .selectFrom("direct_blocks")
    .selectAll()
    .execute();
  const own = rules.find((rule) => rule.user_id === userId);
  return {
    targetId: pair.participantIds.find((id) => id !== userId)!,
    conversationId: pair.conversationId,
    blocked: own?.blocked === 1,
    revision: own?.revision ?? 0,
    canSend: !rules.some((rule) => rule.blocked === 1),
  };
}

export function readBlock(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  pair: DirectPair,
): Promise<BlockOutcome> {
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const mismatch = await verifyDirectPair(database, pair);
    if (mismatch) return mismatch;
    return {
      kind: "block_status",
      status: await status(database, principal.userId, pair),
    };
  });
}

/** Discover the counterpart through existing actor membership, never from message authors. */
export function directStatus(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
): Promise<BlockOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    if (authorized.state.owner_kind !== "conversation")
      return { kind: "invalid_input" };
    const members = await database
      .selectFrom("members")
      .select("user_id")
      .orderBy("user_id")
      .execute();
    if (members.length !== 2) return { kind: "invalid_input" };
    const pair: DirectPair = {
      conversationId: authorized.state.owner_id,
      participantIds: [members[0]!.user_id, members[1]!.user_id],
    };
    const mismatch = await verifyDirectPair(database, pair);
    if (mismatch) return mismatch;
    return {
      kind: "block_status",
      status: await status(database, principal.userId, pair),
    };
  });
}

export async function setBlock(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  pair: DirectPair,
  command: SetBlock,
): Promise<BlockOutcome> {
  const payloadHash = await sha256Hex(
    JSON.stringify({
      commandId: command.commandId,
      issuedAt: command.issuedAt,
      blocked: command.blocked,
      expectedRevision: command.expectedRevision,
    }),
  );
  return storage.transaction(async () => {
    const now = Date.now();
    const invalid = principalFailure(principal, now);
    if (invalid) return invalid;
    const mismatch = await verifyDirectPair(database, pair);
    if (mismatch) return mismatch;
    const expired = commandWindowFailure(command.issuedAt, now);
    if (expired) return expired;
    const current = await status(database, principal.userId, pair);
    const previous = await database
      .selectFrom("block_receipts")
      .selectAll()
      .where("user_id", "=", principal.userId)
      .where("command_id", "=", command.commandId)
      .executeTakeFirst();
    if (previous) {
      if (previous.payload_hash !== payloadHash)
        return { kind: "command_conflict" };
      return {
        kind: "block_updated",
        receipt: {
          targetId: current.targetId,
          conversationId: pair.conversationId,
          blocked: previous.blocked === 1,
          revision: previous.revision,
        },
        status: current,
      };
    }
    if (current.revision !== command.expectedRevision)
      return { kind: "stale_revision", currentRevision: current.revision };
    const [first, second] = [...pair.participantIds].sort();
    await database
      .insertInto("direct_pair")
      .values({
        id: 1,
        conversation_id: pair.conversationId,
        first_user_id: first!,
        second_user_id: second!,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    const revision = current.revision + 1;
    await database
      .insertInto("direct_blocks")
      .values({
        user_id: principal.userId,
        blocked: Number(command.blocked),
        revision,
      })
      .onConflict((conflict) =>
        conflict
          .column("user_id")
          .doUpdateSet({ blocked: Number(command.blocked), revision }),
      )
      .execute();
    await database
      .insertInto("block_receipts")
      .values({
        user_id: principal.userId,
        command_id: command.commandId,
        payload_hash: payloadHash,
        blocked: Number(command.blocked),
        revision,
        accepted_at: now,
      })
      .execute();
    await scheduleAlarm(storage, retentionWake(now, RECEIPT_RETENTION_MS));
    return {
      kind: "block_updated",
      receipt: {
        targetId: current.targetId,
        conversationId: pair.conversationId,
        blocked: command.blocked,
        revision,
      },
      status: await status(database, principal.userId, pair),
    };
  });
}
