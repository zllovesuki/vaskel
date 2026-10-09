import { mediaRoomKey } from "@/server/media/authorization";
import { replaceAlarm, scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  accountDatabase,
  findAccountState,
  readAccountState,
  saveAccountState,
} from "./store";
import {
  cleanupOf,
  currentClaim,
  recoverParticipation,
  settleCleanup,
  type AccountState,
  type CleanupClaim,
} from "./state";
import {
  actorWork,
  ACTOR_RPC_TIMEOUT_MS,
} from "@/server/actors/shared/bounded-work";
import { logEvent } from "@/server/telemetry";

/** Read every account alarm domain under the caller's native transaction. */
async function replaceAccountAlarm(
  ctx: DurableObjectState,
  state: AccountState | undefined,
) {
  const times: number[] = [];
  if (state && cleanupOf(state.participation)) times.push(Date.now() + 1_000);
  if (state?.participation.kind === "joining")
    times.push(state.participation.deadline);
  await replaceAlarm(ctx.storage, times.length ? Math.min(...times) : null);
}

export async function refreshAccountAlarm(
  ctx: DurableObjectState,
  database: ReturnType<typeof accountDatabase>,
) {
  await ctx.storage.transaction(async () => {
    const state = await findAccountState(database);
    await replaceAccountAlarm(ctx, state);
  });
}

function samePredecessor(current: AccountState, target: CleanupClaim) {
  const cleanup = cleanupOf(current.participation);
  return (
    cleanup?.generation === target.generation &&
    mediaRoomKey(cleanup.room) === mediaRoomKey(target.room)
  );
}

export async function closePreviousClaim(
  ctx: DurableObjectState,
  env: Env,
  database: ReturnType<typeof accountDatabase>,
  state: AccountState,
): Promise<boolean> {
  const target = cleanupOf(state.participation);
  if (!target) {
    await refreshAccountAlarm(ctx, database);
    return true;
  }
  const result = await actorWork(ctx.storage, "maintenance").run(
    async () => {
      const started = Date.now();
      try {
        return {
          closed: await attemptPreviousClaim(
            ctx,
            env,
            database,
            state,
            target,
            started,
          ),
        };
      } catch (error) {
        // The pool catches rejections, so carry local failures back to the
        // waiting caller and also report failures that settle after its timeout.
        logCleanupFailure(ctx, started, error);
        return { error };
      }
    },
    Date.now() + ACTOR_RPC_TIMEOUT_MS,
    `predecessor:${mediaRoomKey(target.room)}:${target.generation}`,
  );
  if (result.ok && "error" in result.value) throw result.value.error;
  // A bounded wait or occupied slot still leaves durable retry work.
  if (!result.ok) await refreshAccountAlarm(ctx, database);
  return result.ok && result.value.closed === true;
}

function logCleanupFailure(
  ctx: DurableObjectState,
  started: number,
  error: unknown,
) {
  logEvent(
    "warn",
    "account_media_cleanup",
    {
      actorId: ctx.id.toString(),
      processed: 1,
      pending: 1,
      failed: 1,
      durationMs: Date.now() - started,
    },
    error,
  );
}

async function attemptPreviousClaim(
  ctx: DurableObjectState,
  env: Env,
  database: ReturnType<typeof accountDatabase>,
  state: AccountState,
  target: CleanupClaim,
  started: number,
) {
  const claimed = await ctx.storage.transaction(async () => {
    const current = await readAccountState(database, state.userId);
    // Persist the successor before entering another actor. This complete
    // snapshot also replaces an obsolete immediate enqueue alarm.
    await replaceAccountAlarm(ctx, current);
    return samePredecessor(current, target);
  });
  if (!claimed) return false;
  const { room, generation, reason } = target;
  const result = await env.MEDIA_ROOM.getByName(mediaRoomKey(room))
    .endClaim({
      room,
      participantId: state.userId,
      generation,
      reason,
    })
    .catch((error: unknown) => {
      logCleanupFailure(ctx, started, error);
      return null;
    });
  if (!result) {
    await refreshAccountAlarm(ctx, database);
    return false;
  }
  await ctx.storage.transaction(async () => {
    const current = await readAccountState(database, state.userId);
    // A newer Leave may inherit this exact predecessor. Complete its
    // cleanup without changing its command, generation or terminal cause.
    if (!samePredecessor(current, target)) {
      await replaceAccountAlarm(ctx, current);
      return;
    }
    const next: AccountState = {
      ...current,
      participation: settleCleanup(
        current,
        result.kind === "closed",
        result.disposition,
      ),
    };
    await saveAccountState(database, next);
    // Late settlement refreshes in the same fenced native transaction.
    await replaceAccountAlarm(ctx, next);
  });
  logEvent(result.kind === "closed" ? "log" : "warn", "account_media_cleanup", {
    actorId: ctx.id.toString(),
    processed: 1,
    pending: result.kind === "closed" ? 0 : 1,
    failed: 0,
    durationMs: Date.now() - started,
  });
  return result.kind === "closed";
}

export async function runAccountAlarm(
  ctx: DurableObjectState,
  env: Env,
  database: ReturnType<typeof accountDatabase>,
) {
  const state = await ctx.storage.transaction(async () => {
    const current = await findAccountState(database);
    if (
      !current ||
      current.participation.kind !== "joining" ||
      current.participation.deadline > Date.now()
    )
      return current;
    const next: AccountState = {
      ...current,
      participation: recoverParticipation(current),
    };
    await saveAccountState(database, next);
    await scheduleAlarm(ctx.storage, Date.now() + 1_000);
    return next;
  });
  if (state && cleanupOf(state.participation))
    await closePreviousClaim(ctx, env, database, state);
  else await refreshAccountAlarm(ctx, database);
}

/** Ownership is already committed. Missed disposal converges through room leases. */
export function disposePreviousClaim(
  ctx: DurableObjectState,
  env: Env,
  state: AccountState,
) {
  const claims = [currentClaim(state), cleanupOf(state.participation)];
  for (const claim of claims) {
    if (!claim) continue;
    const { room, generation } = claim;
    void actorWork(ctx.storage, "hints").run(
      async () =>
        await env.MEDIA_ROOM.getByName(mediaRoomKey(room)).endClaim({
          room,
          participantId: state.userId,
          generation,
          reason: "transfer",
        }),
      Date.now() + ACTOR_RPC_TIMEOUT_MS,
      `transfer:${generation}`,
    );
  }
}
