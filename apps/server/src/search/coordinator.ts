import {
  CROSS_SEARCH_CONCURRENCY,
  CROSS_SEARCH_MAX_OWNERS,
  CROSS_SEARCH_QUERY_MIN_CODE_POINTS,
  CROSS_SEARCH_RPC_TIMEOUT_MS,
  CROSS_SEARCH_WORK_BUDGET_MS,
  compareSearchPositions,
  type CrossSearchHit,
  type CrossSearchRequest,
  type CrossSearchResponse,
  type SearchCandidate,
  type SearchPosition,
} from "@vaskel/contracts/search";
import { BoundedWork } from "@/server/actors/shared/bounded-work";
import { principalFailure } from "@/server/actors/shared/policy";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { logEvent } from "@/server/telemetry";
import { actorPrincipal } from "@/server/directory/owners";
import { searchOwnerCandidates } from "@/server/directory/search";
import { decodeSearchCursor, encodeSearchCursor } from "./cursor";

type CandidateOwner = { serverId: string; candidates: SearchCandidate[] };
type PositionedCandidate = SearchCandidate & { serverId: string };
function position(candidate: PositionedCandidate): SearchPosition {
  const { serverId, messageId, createdAt, createdSequence } = candidate;
  return { serverId, messageId, createdAt, createdSequence };
}

export async function crossServerSearch(
  env: Env,
  principal: IdentityPrincipal,
  request: CrossSearchRequest & { limit: number },
  session: D1DatabaseSession,
): Promise<CrossSearchResponse> {
  if (Array.from(request.query).length < CROSS_SEARCH_QUERY_MIN_CODE_POINTS)
    return {
      kind: "query_too_short",
      minimum: CROSS_SEARCH_QUERY_MIN_CODE_POINTS,
    };
  const before = request.cursor ? decodeSearchCursor(request.cursor) : null;
  if (request.cursor && !before) return { kind: "invalid_input" };
  const trusted = actorPrincipal(principal);
  const deadline = Math.min(
    trusted.expiresAt,
    Date.now() + CROSS_SEARCH_WORK_BUDGET_MS,
  );
  const reads = new BoundedWork(
    CROSS_SEARCH_CONCURRENCY,
    CROSS_SEARCH_RPC_TIMEOUT_MS,
  );
  const denied = new Set<string>();
  const unavailableIds = new Set<string>();
  const coverage = { limited: false, unavailable: false };
  function unavailable(stage: "candidates" | "materialize", ownerId: string) {
    coverage.unavailable = true;
    unavailableIds.add(ownerId);
    logEvent("warn", "cross_search_owner_unavailable", {
      operation: stage,
      ownerId,
    });
  }
  const discovered = await reads.run(
    () => searchOwnerCandidates(env, principal, request.serverId, session),
    deadline,
  );
  if (!discovered.ok)
    return (
      principalFailure(trusted) ?? {
        kind: "cross_matches",
        hits: [],
        deniedServerIds: [],
        unavailableServerIds: [],
        coverage: { limited: false, unavailable: true },
        nextCursor: null,
      }
    );
  const owners = discovered.value.serverIds;
  coverage.limited = discovered.value.limited;
  if (request.serverId && !owners.length) denied.add(request.serverId);
  const candidates: CandidateOwner[] = [];
  let offset = 0;
  while (
    offset < owners.length &&
    candidates.length < CROSS_SEARCH_MAX_OWNERS &&
    Date.now() < deadline
  ) {
    const batch = owners.slice(
      offset,
      offset +
        Math.min(
          CROSS_SEARCH_CONCURRENCY,
          CROSS_SEARCH_MAX_OWNERS - candidates.length,
        ),
    );
    offset += batch.length;
    const results = await reads.map(
      batch,
      async (serverId) =>
        await env.SERVER_DO.getByName(serverId).searchCandidates(trusted, {
          query: request.query,
          limit: request.limit,
          ...(request.channelId === undefined
            ? {}
            : { channelId: request.channelId }),
          ...(before ? { before } : {}),
        }),
      deadline,
    );
    for (const [index, result] of results.entries()) {
      const serverId = batch[index]!;
      if (!result.ok) {
        unavailable("candidates", serverId);
        continue;
      }
      const outcome = result.value;
      if (outcome.kind === "unauthenticated") return outcome;
      if (outcome.kind === "forbidden" || outcome.kind === "not_found") {
        denied.add(serverId);
        continue;
      }
      if (outcome.kind !== "search_candidates") {
        unavailable("candidates", serverId);
        continue;
      }
      candidates.push({ serverId, candidates: outcome.candidates });
    }
  }
  coverage.limited ||= offset < owners.length;
  const keys = candidates
    .flatMap((owner) =>
      owner.candidates.map((key) => ({ ...key, serverId: owner.serverId })),
    )
    .sort(compareSearchPositions);
  const selected = keys.slice(0, request.limit);
  const selection = candidates
    .map((owner) => ({
      serverId: owner.serverId,
      selected: selected
        .filter((key) => key.serverId === owner.serverId)
        .map(({ serverId: _id, ...key }) => key),
    }))
    .filter((owner) => owner.selected.length > 0);
  const materialized = await reads.map(
    selection,
    async (owner) =>
      await env.SERVER_DO.getByName(owner.serverId).materializeSearch(trusted, {
        ...(request.channelId === undefined
          ? {}
          : { channelId: request.channelId }),
        candidates: owner.selected,
      }),
    deadline,
  );
  const hits: CrossSearchHit[] = [];
  for (const [index, result] of materialized.entries()) {
    const owner = selection[index]!;
    if (!result.ok) {
      unavailable("materialize", owner.serverId);
      continue;
    }
    const outcome = result.value;
    if (outcome.kind === "unauthenticated") return outcome;
    if (outcome.kind === "forbidden" || outcome.kind === "not_found") {
      denied.add(owner.serverId);
      continue;
    }
    if (outcome.kind !== "search_materialized") {
      unavailable("materialize", owner.serverId);
      continue;
    }
    const { serverId, serverName } = outcome;
    hits.push(...outcome.hits.map((hit) => ({ ...hit, serverId, serverName })));
  }
  const expired = principalFailure(trusted);
  if (expired) return expired;
  hits.sort((a, b) =>
    compareSearchPositions(
      { ...a.message, serverId: a.serverId, messageId: a.message.id },
      { ...b.message, serverId: b.serverId, messageId: b.message.id },
    ),
  );
  // Advance through the selected window even when some bodies changed or were unavailable.
  const frontier = selected.at(-1);
  return {
    kind: "cross_matches",
    hits,
    deniedServerIds: [...denied],
    unavailableServerIds: [...unavailableIds],
    coverage,
    nextCursor:
      frontier && keys.length > request.limit
        ? encodeSearchCursor(position(frontier))
        : null,
  };
}
