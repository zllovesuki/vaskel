import type { RebuildSearchIndexesEvent } from "@vaskel/contracts/search";
import { OPERATOR_PAGE_LIMIT } from "@vaskel/contracts/instance";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { identityDatabase } from "@/server/auth/database";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { actorPrincipal, ownerStub } from "@/server/directory/owners";
import { logEvent } from "@/server/telemetry";

/** One request owns enumeration; completed owners need no cross-owner commit. */
export async function* rebuildSearchIndexes(
  env: Env,
  original: IdentityPrincipal,
  refreshPrincipal: () => Promise<IdentityPrincipal | null>,
  aborted: () => boolean,
): AsyncGenerator<RebuildSearchIndexesEvent> {
  const counts = { rebuilt: 0, failed: 0, indexedMessages: 0 };
  let after = "";
  let owners: OwnerScope[] = [];
  yield { type: "progress", ...counts };
  while (!aborted()) {
    // Refresh after each owner's work; an old assertion cannot authorize a long run.
    const principal = await refreshPrincipal();
    if (aborted()) return;
    if (
      !principal ||
      principal.userId !== original.userId ||
      principal.sessionId !== original.sessionId
    ) {
      yield { type: "error", kind: "unauthenticated" };
      return;
    }
    if (!principal.isOperator) {
      yield { type: "error", kind: "forbidden" };
      return;
    }
    if (owners.length === 0) {
      owners = await identityDatabase(env)
        .selectFrom("resource_directory")
        .select(["id", "kind"])
        .where("lifecycle", "=", "ready")
        .where("id", ">", after)
        .orderBy("id")
        .limit(OPERATOR_PAGE_LIMIT)
        .execute();
      if (aborted()) return;
      if (owners.length === 0) {
        yield { type: "complete", ...counts };
        return;
      }
      after = owners.at(-1)!.id;
      // Directory I/O must not age the assertion used for the next mutation.
      continue;
    }
    const owner = owners.shift()!;
    try {
      const outcome = await ownerStub(env, owner).rebuildSearchIndex({
        ...actorPrincipal(principal),
        isOperator: true,
      });
      if (aborted()) return;
      if (outcome.kind === "unauthenticated" || outcome.kind === "forbidden") {
        yield { type: "error", kind: outcome.kind };
        return;
      }
      if (outcome.kind === "search_index_rebuilt") {
        counts.rebuilt++;
        counts.indexedMessages += outcome.indexedMessages;
      } else counts.failed++;
    } catch (error) {
      counts.failed++;
      logEvent(
        "warn",
        "search_index_rebuild_failed",
        { ownerId: owner.id },
        error,
      );
    }
    if (aborted()) return;
    yield { type: "progress", ...counts };
  }
}
