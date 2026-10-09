import { BoundedWork } from "@/server/actors/shared/bounded-work";
import {
  ACTIVITY_OWNER_PAGE_SIZE,
  type ActivityPage,
  type OwnerActivity,
} from "@vaskel/contracts/activity";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { directoryDatabase } from "./database";
import { actorPrincipal, ownerStub } from "./owners";
import { logEvent } from "@/server/telemetry";

export async function listActivity(
  env: Env,
  principal: IdentityPrincipal,
  after: string | undefined,
  session: D1DatabaseSession,
): Promise<ActivityPage> {
  let query = directoryDatabase(env, session)
    .selectFrom("resource_membership_index as membership")
    .innerJoin(
      "resource_directory as resource",
      "resource.id",
      "membership.resource_id",
    )
    .select(["resource.id", "resource.kind"])
    .where("membership.user_id", "=", principal.userId)
    .where("resource.lifecycle", "=", "ready")
    .orderBy("resource.id")
    .limit(ACTIVITY_OWNER_PAGE_SIZE + 1);
  if (after) query = query.where("resource.id", ">", after);
  const rows = await query.execute();
  const candidates = rows.slice(0, ACTIVITY_OWNER_PAGE_SIZE);
  const owners: OwnerActivity[] = [];
  const unavailableOwners: OwnerScope[] = [];
  const results = await new BoundedWork(4).map(candidates, async (owner) =>
    ownerStub(env, owner).activity(actorPrincipal(principal), {}),
  );
  for (const [index, result] of results.entries()) {
    const candidate = candidates[index]!;
    if (result.ok && result.value.kind === "owner_activity") {
      const { kind: _kind, ...summary } = result.value;
      owners.push(summary);
    } else if (
      !result.ok ||
      (result.value.kind !== "forbidden" && result.value.kind !== "not_found")
    ) {
      logEvent("warn", "activity_owner_lookup_failed", {
        ownerId: candidate.id,
      });
      // A stale membership hint grants nothing; failures must never look read.
      unavailableOwners.push(candidate);
    }
  }
  const nextCursor =
    rows.length > ACTIVITY_OWNER_PAGE_SIZE
      ? (candidates.at(-1)?.id ?? null)
      : null;
  return {
    kind: "activity",
    owners,
    unavailableOwners,
    partial:
      unavailableOwners.length > 0 ||
      nextCursor !== null ||
      owners.some((owner) => owner.nextCursor !== null),
    nextCursor,
  };
}
