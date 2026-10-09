import { BoundedWork } from "@/server/actors/shared/bounded-work";
import { logEvent } from "@/server/telemetry";
import type { z } from "zod";
import {
  BLOCK_PAGE_SIZE,
  type BlockListSchema,
  type BlockOutcome,
  type BlockStatus,
  type BlockStatusesSchema,
  type SetBlock,
} from "@vaskel/contracts/blocking";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { liveIdentity } from "@/server/auth/sql-authority";
import { directoryDatabase } from "./database";
import { directConversationId } from "./identifiers";
import { actorPrincipal } from "./owners";

/** Status reads validate identity and verified targets on primary without publishing discovery. */
export async function validBlockTargets(
  env: Env,
  principal: IdentityPrincipal,
  targetIds: string[],
): Promise<boolean> {
  const targets = await directoryDatabase(env)
    .selectFrom("identity_user")
    .select("id")
    .where("id", "in", targetIds)
    .where("emailVerified", "=", 1)
    .where(liveIdentity(principal))
    .execute();
  return targets.length === targetIds.length;
}

/** A reference is inserted before owner mutation, including retries and unblocks. */
async function rememberBlockCandidate(
  env: Env,
  principal: IdentityPrincipal,
  targetId: string,
  conversationId: string,
  session?: D1DatabaseSession,
): Promise<boolean> {
  const database = directoryDatabase(env, session);
  const saved = await database
    .insertInto("block_candidates")
    .columns(["user_id", "target_id", "conversation_id"])
    .expression(
      database
        .selectFrom("identity_user")
        .select((expression) => [
          expression.val(principal.userId).as("user_id"),
          "id as target_id",
          expression.val(conversationId).as("conversation_id"),
        ])
        .where("id", "=", targetId)
        .where("emailVerified", "=", 1)
        .where(liveIdentity(principal)),
    )
    .onConflict((conflict) =>
      conflict
        .columns(["user_id", "target_id"])
        .doUpdateSet({ conversation_id: conversationId }),
    )
    .returning("target_id")
    .executeTakeFirst();
  return saved !== undefined;
}

export async function changeBlock(
  env: Env,
  principal: IdentityPrincipal,
  targetId: string,
  command: SetBlock,
  session?: D1DatabaseSession,
): Promise<BlockOutcome> {
  if (targetId === principal.userId) return { kind: "invalid_input" };
  const id = await directConversationId(principal.userId, targetId);
  if (!(await rememberBlockCandidate(env, principal, targetId, id, session)))
    return { kind: "not_found" };
  return env.CONVERSATION_DO.getByName(id).setBlock(
    actorPrincipal(principal),
    targetId,
    command,
  );
}

export async function getBlock(
  env: Env,
  principal: IdentityPrincipal,
  targetId: string,
): Promise<BlockOutcome> {
  if (targetId === principal.userId) return { kind: "invalid_input" };
  const id = await directConversationId(principal.userId, targetId);
  if (!(await validBlockTargets(env, principal, [targetId])))
    return { kind: "not_found" };
  const result = await env.CONVERSATION_DO.getByName(id).blockStatus(
    actorPrincipal(principal),
    targetId,
  );
  if (
    result.kind === "block_status" &&
    result.status.blocked &&
    !(await validBlockTargets(env, principal, [targetId]))
  )
    return { kind: "unauthenticated" };
  return result;
}

interface Candidate {
  targetId: string;
  conversationId: string;
}
async function resolveCandidates(
  env: Env,
  principal: IdentityPrincipal,
  candidates: Candidate[],
) {
  const statuses: BlockStatus[] = [];
  const unavailableTargetIds: string[] = [];
  const outcomes = await new BoundedWork(8).map(candidates, async (candidate) =>
    env.CONVERSATION_DO.getByName(candidate.conversationId).blockStatus(
      actorPrincipal(principal),
      candidate.targetId,
    ),
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.ok && outcome.value.kind === "block_status")
      statuses.push(outcome.value.status);
    else {
      const candidate = candidates[index]!;
      // A timeout or skipped read cannot establish that this pair is unblocked.
      unavailableTargetIds.push(candidate.targetId);
      if (!outcome.ok)
        logEvent("warn", "block_owner_lookup_failed", {
          ownerId: candidate.conversationId,
        });
    }
  }
  return {
    statuses,
    unavailableTargetIds,
    partial: unavailableTargetIds.length > 0,
  };
}

export async function listBlocks(
  env: Env,
  principal: IdentityPrincipal,
  after?: string,
  session?: D1DatabaseSession,
): Promise<z.infer<typeof BlockListSchema>> {
  let query = directoryDatabase(env, session)
    .selectFrom("block_candidates")
    .select(["target_id as targetId", "conversation_id as conversationId"])
    .where("user_id", "=", principal.userId)
    .orderBy("target_id")
    .limit(BLOCK_PAGE_SIZE + 1);
  if (after) query = query.where("target_id", ">", after);
  const candidates = await query.execute();
  const resolved = await resolveCandidates(
    env,
    principal,
    candidates.slice(0, BLOCK_PAGE_SIZE),
  );
  return {
    kind: "blocks",
    blocks: resolved.statuses.filter((value) => value.blocked),
    partial: resolved.partial,
    unavailableTargetIds: resolved.unavailableTargetIds,
    nextCursor:
      candidates.length > BLOCK_PAGE_SIZE
        ? candidates[BLOCK_PAGE_SIZE - 1]!.targetId
        : null,
  };
}

/** Viewer-directed shared-room notices use the same pair owners without opening DMs. */
export async function resolveBlocks(
  env: Env,
  principal: IdentityPrincipal,
  targetIds: string[],
  session?: D1DatabaseSession,
): Promise<z.infer<typeof BlockStatusesSchema>> {
  if (targetIds.includes(principal.userId)) return { kind: "invalid_input" };
  const people = await directoryDatabase(env, session)
    .selectFrom("identity_user")
    .select("id")
    .where("id", "in", targetIds)
    .where("emailVerified", "=", 1)
    .execute();
  const existing = new Set(people.map((person) => person.id));
  const candidates = await Promise.all(
    targetIds
      .filter((id) => existing.has(id))
      .map(async (targetId) => ({
        targetId,
        conversationId: await directConversationId(principal.userId, targetId),
      })),
  );
  const resolved = await resolveCandidates(env, principal, candidates);
  const unavailableTargetIds = [
    ...resolved.unavailableTargetIds,
    ...targetIds.filter((id) => !existing.has(id)),
  ];
  const positive = resolved.statuses
    .filter((status) => status.blocked)
    .map((status) => status.targetId);
  if (positive.length && !(await validBlockTargets(env, principal, positive)))
    return { kind: "unauthenticated" };
  return {
    kind: "block_statuses",
    statuses: resolved.statuses,
    unavailableTargetIds,
    partial: unavailableTargetIds.length > 0,
  };
}
