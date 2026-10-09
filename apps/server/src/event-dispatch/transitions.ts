import {
  actorWork,
  ACTOR_WORK_BUDGET_MS,
} from "@/server/actors/shared/bounded-work";
import { directoryDatabase } from "@/server/directory/database";
import { ownerStub } from "@/server/directory/owners";
import { logEvent } from "@/server/telemetry";

// Only prompt hints use this discovery bound; sampling repairs every mounted scope.
const TRANSITION_ACCOUNT_LIMIT = 32;
const TRANSITION_OWNER_LIMIT = 32;

/** No cursor, acknowledgement or retry: lost transitions are repaired by samples. */
export function emitPresenceTransitions(
  ctx: DurableObjectState,
  env: Env,
  userIds: readonly string[],
): void {
  const deadline = Date.now() + ACTOR_WORK_BUDGET_MS;
  const pool = actorWork(ctx.storage, "hints");
  ctx.waitUntil(
    pool
      .map(
        [...new Set(userIds)].slice(0, TRANSITION_ACCOUNT_LIMIT),
        async (userId) => {
          const owners = await directoryDatabase(env)
            .selectFrom("resource_membership_index as membership")
            .innerJoin(
              "resource_directory as resource",
              "resource.id",
              "membership.resource_id",
            )
            .select(["resource.id", "resource.kind"])
            .where("membership.user_id", "=", userId)
            .where("resource.lifecycle", "=", "ready")
            .orderBy("resource.id")
            .limit(TRANSITION_OWNER_LIMIT)
            .execute();
          // Sequential RPCs keep discovery from multiplying the hub's outstanding pool.
          for (const owner of owners) {
            if (Date.now() >= deadline) break;
            await ownerStub(env, owner).emitPresenceHint(userId);
          }
        },
        deadline,
      )
      .then(() => {})
      .catch((error) => {
        logEvent(
          "warn",
          "presence_transition_discovery_failed",
          { actorId: ctx.id.toString() },
          error,
        );
      }),
  );
}
