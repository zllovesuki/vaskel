import { z } from "zod";
import { ChannelSchema } from "./resources";
import { MessageSchema } from "./messaging";

export const CROSS_SEARCH_DEFAULT_LIMIT = 20;
export const CROSS_SEARCH_MAX_LIMIT = 40;
export const CROSS_SEARCH_MAX_OWNERS = 8;
export const CROSS_SEARCH_CONCURRENCY = 4;
export const CROSS_SEARCH_RPC_TIMEOUT_MS = 2_000;
export const CROSS_SEARCH_WORK_BUDGET_MS = 10_000;
export const CROSS_SEARCH_MAX_CANDIDATES = 50;
export const CROSS_SEARCH_CURSOR_MAX_LENGTH = 4 * 1_024;
export const CROSS_SEARCH_QUERY_MAX_LENGTH = 1_024;
export const CROSS_SEARCH_QUERY_MIN_CODE_POINTS = 3;
export const CROSS_SEARCH_QUERY_MAX_CODE_POINTS = 256;

// Check the transport bound before trimming; short queries have a tagged outcome.
export const CrossSearchQuerySchema = z
  .string()
  .max(CROSS_SEARCH_QUERY_MAX_LENGTH)
  .transform((query) => query.trim())
  .refine(
    (query) => Array.from(query).length <= CROSS_SEARCH_QUERY_MAX_CODE_POINTS,
  );
const pageLimit = z.number().int().min(1).max(CROSS_SEARCH_MAX_LIMIT);
const sequence = z.number().int().positive();
const timestamp = z.number().int().nonnegative();

export const CrossSearchRequestSchema = z
  .strictObject({
    query: CrossSearchQuerySchema,
    serverId: z.uuid().optional(),
    channelId: ChannelSchema.shape.id.optional(),
    limit: pageLimit.default(CROSS_SEARCH_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(CROSS_SEARCH_CURSOR_MAX_LENGTH).optional(),
  })
  .refine(
    (request) =>
      request.channelId === undefined || request.serverId !== undefined,
    { path: ["channelId"], message: "A channel filter requires a server." },
  );
export type CrossSearchRequest = z.input<typeof CrossSearchRequestSchema>;

export const SearchFailureSchema = z.union([
  z.strictObject({ kind: z.literal("invalid_input") }),
  z.strictObject({ kind: z.literal("unauthenticated") }),
  z.strictObject({ kind: z.literal("forbidden") }),
  z.strictObject({ kind: z.literal("not_found") }),
  z.strictObject({ kind: z.literal("query_too_short"), minimum: z.literal(3) }),
]);
export type SearchFailure = z.infer<typeof SearchFailureSchema>;

export const RebuildSearchIndexOutcomeSchema = z.union([
  z.strictObject({
    kind: z.enum(["unauthenticated", "forbidden", "not_found"]),
  }),
  z.strictObject({
    kind: z.literal("search_index_rebuilt"),
    indexedMessages: z.number().int().nonnegative(),
  }),
]);
export type RebuildSearchIndexOutcome = z.infer<
  typeof RebuildSearchIndexOutcomeSchema
>;

export const RebuildSearchIndexesRequestSchema = z.strictObject({});
const rebuildCounts = {
  rebuilt: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  indexedMessages: z.number().int().nonnegative(),
};
export const RebuildSearchIndexesEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), ...rebuildCounts }),
  z.strictObject({ type: z.literal("complete"), ...rebuildCounts }),
  z.strictObject({
    type: z.literal("error"),
    kind: z.enum(["unauthenticated", "forbidden", "unavailable"]),
  }),
]);
export type RebuildSearchIndexesEvent = z.infer<
  typeof RebuildSearchIndexesEventSchema
>;
export type RebuildSearchIndexesSummary = Extract<
  RebuildSearchIndexesEvent,
  { type: "complete" }
>;

export const SearchPositionSchema = z.strictObject({
  createdAt: timestamp,
  createdSequence: sequence,
  serverId: z.uuid(),
  messageId: MessageSchema.shape.id,
});
export type SearchPosition = z.infer<typeof SearchPositionSchema>;
/** Ascending comparator for the descending creation order and binary ID ties. */
export function compareSearchPositions(a: SearchPosition, b: SearchPosition) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.createdSequence !== b.createdSequence)
    return b.createdSequence - a.createdSequence;
  if (a.serverId !== b.serverId) return a.serverId < b.serverId ? -1 : 1;
  return a.messageId === b.messageId ? 0 : a.messageId < b.messageId ? -1 : 1;
}

export const SearchCandidateSchema = z.strictObject({
  messageId: MessageSchema.shape.id,
  createdAt: timestamp,
  createdSequence: sequence,
  version: sequence,
});
export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;
export const SearchCandidatesRequestSchema = z.strictObject({
  query: CrossSearchQuerySchema,
  channelId: ChannelSchema.shape.id.optional(),
  limit: pageLimit,
  before: SearchPositionSchema.optional(),
});
export type SearchCandidatesRequest = z.infer<
  typeof SearchCandidatesRequestSchema
>;
export const SearchCandidatesOutcomeSchema = z.union([
  SearchFailureSchema,
  z.strictObject({
    kind: z.literal("search_candidates"),
    candidates: z.array(SearchCandidateSchema).max(CROSS_SEARCH_MAX_LIMIT + 1),
  }),
]);
export type SearchCandidatesOutcome = z.infer<
  typeof SearchCandidatesOutcomeSchema
>;

export const MaterializeSearchRequestSchema = z.strictObject({
  channelId: ChannelSchema.shape.id.optional(),
  candidates: z
    .array(SearchCandidateSchema)
    .min(1)
    .max(CROSS_SEARCH_MAX_LIMIT)
    .refine(
      (candidates) =>
        new Set(candidates.map((candidate) => candidate.messageId)).size ===
        candidates.length,
    ),
});
export type MaterializeSearchRequest = z.infer<
  typeof MaterializeSearchRequestSchema
>;
const materializedHit = z.strictObject({
  channel: ChannelSchema.pick({ id: true, name: true }),
  message: MessageSchema,
});
export const MaterializeSearchOutcomeSchema = z.union([
  SearchFailureSchema,
  z.strictObject({
    kind: z.literal("search_materialized"),
    serverId: z.uuid(),
    serverName: z.string(),
    hits: z.array(materializedHit).max(CROSS_SEARCH_MAX_LIMIT),
  }),
]);
export type MaterializeSearchOutcome = z.infer<
  typeof MaterializeSearchOutcomeSchema
>;

export const CrossSearchHitSchema = materializedHit.extend({
  serverId: z.uuid(),
  serverName: z.string(),
});
export type CrossSearchHit = z.infer<typeof CrossSearchHitSchema>;
export const CrossSearchCoverageSchema = z.strictObject({
  limited: z.boolean(),
  unavailable: z.boolean(),
});
export type CrossSearchCoverage = z.infer<typeof CrossSearchCoverageSchema>;
export const CrossSearchResponseSchema = z.union([
  SearchFailureSchema,
  z.strictObject({
    kind: z.literal("cross_matches"),
    hits: z.array(CrossSearchHitSchema).max(CROSS_SEARCH_MAX_LIMIT),
    deniedServerIds: z.array(z.uuid()).max(CROSS_SEARCH_MAX_CANDIDATES),
    unavailableServerIds: z.array(z.uuid()).max(CROSS_SEARCH_MAX_CANDIDATES),
    coverage: CrossSearchCoverageSchema,
    nextCursor: z
      .string()
      .min(1)
      .max(CROSS_SEARCH_CURSOR_MAX_LENGTH)
      .nullable(),
  }),
]);
export type CrossSearchResponse = z.infer<typeof CrossSearchResponseSchema>;
