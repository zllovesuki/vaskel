import type {
  PresenceOutcome,
  PresenceRequest,
  PresenceSample,
} from "@vaskel/contracts/presence";
import {
  BoundedWork,
  ACTOR_WORK_BUDGET_MS,
} from "@/server/actors/shared/bounded-work";
import { principalFailure } from "@/server/actors/shared/policy";
import type { IdentityPrincipal } from "@/server/auth/principal";
import {
  actorPrincipal,
  knownOwners,
  ownerKey,
} from "@/server/directory/owners";
import {
  eventDispatchStub,
  groupEventDispatchRecipients,
} from "@/server/event-dispatch/routing";

/** A bounded composed read, with one original assertion across both fanout stages. */
export async function sampleOwnerPresence(
  env: Env,
  principal: IdentityPrincipal,
  input: PresenceRequest,
  session?: D1DatabaseSession,
): Promise<PresenceOutcome> {
  const assertion = actorPrincipal(principal);
  const expired = principalFailure(assertion);
  if (expired) return expired;
  const deadline = Math.min(
    assertion.expiresAt,
    Date.now() + ACTOR_WORK_BUDGET_MS,
  );
  const pool = new BoundedWork(4);
  const discovery = await pool.run(
    () =>
      knownOwners(
        env,
        input.scopes.map((scope) => scope.owner),
        session,
      ),
    deadline,
  );
  if (!discovery.ok)
    return (
      principalFailure(assertion) ?? {
        kind: "presence",
        scopes: input.scopes.map((scope) => ({
          kind: "unavailable",
          owner: scope.owner,
        })),
      }
    );
  const candidates = await pool.map(
    input.scopes,
    async (scope) => {
      const owner = discovery.value.get(ownerKey(scope.owner));
      if (!owner) return { kind: "not_found" } as const;
      return owner.stub.presenceCandidates(
        assertion,
        "userIds" in scope
          ? { userIds: scope.userIds }
          : { after: scope.after },
      );
    },
    deadline,
  );
  const ids = new Set<string>();
  for (const result of candidates)
    if (result.ok && result.value.kind === "presence_candidates")
      for (const userId of result.value.userIds) ids.add(userId);
  const samples = new Map<string, PresenceSample>();
  const groups = groupEventDispatchRecipients([...ids]);
  const sampled = await pool.map(
    groups,
    async (group) =>
      eventDispatchStub(env, group.recipients[0]!).samplePresence(
        group.recipients,
      ),
    deadline,
  );
  for (const result of sampled) {
    if (!result.ok || result.value.kind !== "presence_samples") continue;
    for (const value of result.value.samples) samples.set(value.userId, value);
  }
  // A slow owner/hub must never extend the authority that admitted this read.
  const ended = principalFailure(assertion);
  if (ended) return ended;
  return {
    kind: "presence",
    scopes: input.scopes.map((scope, index) => {
      const result = candidates[index]!;
      if (!result.ok) return { kind: "unavailable", owner: scope.owner };
      if (result.value.kind !== "presence_candidates")
        return {
          kind:
            result.value.kind === "forbidden" ||
            result.value.kind === "not_found"
              ? "denied"
              : "unavailable",
          owner: scope.owner,
        };
      return {
        kind: "sampled",
        owner: scope.owner,
        nextCursor: result.value.nextCursor,
        samples: result.value.userIds.map(
          (userId) => samples.get(userId) ?? { userId, state: "unknown" },
        ),
      };
    }),
  };
}
