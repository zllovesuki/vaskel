import { z } from "zod";
import {
  UiLanguageSchema,
  type AccountPreferences,
} from "@vaskel/contracts/preferences";
import {
  MessageSchema,
  MESSAGE_BYTE_LIMIT,
  OwnerScopeSchema,
  ReplayCursorSchema,
  type OwnerScope,
} from "@vaskel/contracts/messaging";

export const HISTORY_DATABASE = "vaskel-local";
export const HISTORY_FORMAT = 3;
export const HISTORY_CHANNEL_LIMIT = 16;
export const HISTORY_MESSAGE_LIMIT = 200;
export const HISTORY_BYTE_LIMIT = 8 * 1_024 * 1_024;

const identifier = z.string().min(1).max(128);
const label = z.string().min(1).max(256);
const position = z.number().int().nonnegative();
const origin = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      return new URL(value).origin === value && value !== "null";
    } catch {
      return false;
    }
  });

export const AccountCaptureSchema = z.strictObject({
  origin,
  cacheId: z.uuid(),
  accountEpoch: z.uuid(),
  accountId: identifier.nullable(),
});
export type AccountCapture = z.infer<typeof AccountCaptureSchema>;
export const AccountFenceSchema = AccountCaptureSchema.extend({
  accountId: identifier,
});
export type AccountFence = z.infer<typeof AccountFenceSchema>;
/** Account-scoped display data; never an authenticated profile. */
export const DisplayLanguageHintSchema = z.strictObject({
  fence: AccountFenceSchema,
  language: UiLanguageSchema,
  revision: z.number().int().positive().safe(),
});
export type DisplayLanguageHint = z.infer<typeof DisplayLanguageHintSchema>;
export const ScopeCaptureSchema = AccountFenceSchema.extend({
  retirementRevision: position,
  owner: OwnerScopeSchema,
  scopeEpoch: z.uuid(),
  generation: z.uuid().nullable(),
});
export type ScopeCapture = z.infer<typeof ScopeCaptureSchema>;
export const HistoryFenceSchema = ScopeCaptureSchema.extend({
  generation: z.uuid(),
});
export type HistoryFence = z.infer<typeof HistoryFenceSchema>;

export const CacheMetaSchema = z
  .strictObject({
    format: z.literal(HISTORY_FORMAT),
    retirementRevision: position,
    cacheId: z.uuid(),
    accountEpoch: z.uuid(),
    accountId: identifier.nullable(),
    accountLabel: label.nullable(),
  })
  .refine(
    (value) => (value.accountId === null) === (value.accountLabel === null),
  );
export type CacheMeta = z.infer<typeof CacheMetaSchema>;
export const CacheScopeSchema = z
  .strictObject({
    scopeEpoch: z.uuid(),
    generation: z.uuid().nullable(),
    eligible: z.boolean(),
  })
  .refine((value) => !value.eligible || value.generation !== null);
export type CacheScope = z.infer<typeof CacheScopeSchema>;

export const HistoryLabelsSchema = z.strictObject({
  owner: label,
  channel: label,
  authors: z.array(z.strictObject({ id: identifier, label })),
});
export type HistoryLabels = z.infer<typeof HistoryLabelsSchema>;
export type SnapshotLabels = HistoryLabels;
export const HistoryProjectionSchema = z.strictObject({
  cursor: ReplayCursorSchema,
  messages: z.array(MessageSchema),
  nextBefore: position.nullable(),
  labels: HistoryLabelsSchema,
});
export type HistoryProjection = z.infer<typeof HistoryProjectionSchema>;

const SnapshotShapeSchema = HistoryProjectionSchema.extend({
  format: z.literal(HISTORY_FORMAT),
  fence: HistoryFenceSchema,
  messages: z.array(MessageSchema).max(HISTORY_MESSAGE_LIMIT),
  savedAt: position,
  byteLength: position.max(HISTORY_BYTE_LIMIT),
});
type SnapshotShape = z.infer<typeof SnapshotShapeSchema>;

/** Encoded record size includes its byteLength field, using a stable fixed point. */
export function snapshotByteLength(value: SnapshotShape): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (;;) {
    const next = encoder.encode(
      JSON.stringify({ ...value, byteLength: bytes }),
    ).byteLength;
    if (next === bytes) return next;
    bytes = next;
  }
}

export function sameOwner(a: OwnerScope, b: OwnerScope): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export const CachedSnapshotSchema = SnapshotShapeSchema.superRefine(
  (snapshot, ctx) => {
    const { cursor, fence, messages, labels } = snapshot;
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      !sameOwner(cursor.owner, fence.owner) ||
      cursor.generation !== fence.generation
    )
      invalid("Snapshot owner and generation must match its fence.");
    const ids = new Set<string>();
    const authors = new Set<string>();
    let previous = 0;
    for (const message of messages) {
      if (
        message.channelId !== cursor.channelId ||
        ids.has(message.id) ||
        message.createdSequence <= previous ||
        message.updatedSequence < message.createdSequence ||
        message.updatedSequence > cursor.sequence
      )
        invalid(
          "Messages must form an ordered, unique, acknowledged channel window.",
        );
      ids.add(message.id);
      authors.add(message.authorId);
      if (message.quote) authors.add(message.quote.authorId);
      previous = message.createdSequence;
    }
    const labeled = new Set<string>();
    for (const author of labels.authors) {
      if (!authors.has(author.id) || labeled.has(author.id))
        invalid("Only retained authors may have one display label.");
      labeled.add(author.id);
    }
    if (
      snapshot.nextBefore !== null &&
      (snapshot.nextBefore < 1 ||
        snapshot.nextBefore > cursor.sequence ||
        (messages[0] && snapshot.nextBefore > messages[0].createdSequence))
    )
      invalid("Older-history position must precede the retained window.");
    if (
      messages.some(
        (message) =>
          message.body !== null &&
          new TextEncoder().encode(message.body).byteLength >
            MESSAGE_BYTE_LIMIT,
      )
    )
      invalid("Cached message bodies must respect the message byte limit.");
    if (snapshot.byteLength !== snapshotByteLength(snapshot))
      invalid("Encoded snapshot length does not match.");
  },
);
export type CachedSnapshot = z.infer<typeof CachedSnapshotSchema>;

export interface CachedAccount {
  accountId: string;
  label: string;
  fence: AccountFence;
  snapshots: CachedSnapshot[];
  displayLanguage?: DisplayLanguageHint;
}

export type CacheUnavailableReason =
  | "unsupported"
  | "blocked"
  | "timeout"
  | "storage"
  | "quota"
  | "corrupt"
  | "invalid-record"
  | "closed";
export type CacheResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "miss" }
  | { kind: "stale" }
  | { kind: "unavailable"; reason: CacheUnavailableReason };

export const CacheInvalidationSchema = z.discriminatedUnion("type", [
  AccountCaptureSchema.extend({ type: z.literal("account") }),
  AccountFenceSchema.extend({
    type: z.literal("drafts_retired"),
    owner: OwnerScopeSchema,
  }),
  ScopeCaptureSchema.extend({ type: z.literal("owner") }),
  ScopeCaptureSchema.extend({ type: z.literal("evicted") }),
  z.strictObject({ type: z.literal("cache"), origin }),
]);
/** These identities/epochs may cross tabs. Content and account labels never do. */
export type CacheInvalidation = z.infer<typeof CacheInvalidationSchema>;

export interface HistoryCache {
  captureAccount(): Promise<CacheResult<AccountCapture>>;
  activateAccount(
    capture: AccountCapture,
    account: { accountId: string; label: string },
  ): Promise<CacheResult<AccountFence>>;
  saveDisplayLanguage(
    fence: AccountFence,
    preferences: AccountPreferences,
  ): Promise<CacheResult<undefined>>;
  captureScope(
    account: AccountFence,
    owner: OwnerScope,
  ): Promise<CacheResult<ScopeCapture>>;
  authorizeScope(
    capture: ScopeCapture,
    generation: string,
  ): Promise<CacheResult<HistoryFence>>;
  save(
    fence: HistoryFence,
    projection: HistoryProjection,
    options: { replace: boolean },
  ): Promise<CacheResult<CachedSnapshot>>;
  readAccount(): Promise<CacheResult<CachedAccount>>;
  readSnapshot(
    fence: HistoryFence,
    channelId: string,
  ): Promise<CacheResult<CachedSnapshot>>;
  recheck(
    fence: AccountCapture | ScopeCapture,
  ): Promise<CacheResult<undefined>>;
  invalidateAccount(capture: AccountCapture): Promise<CacheResult<undefined>>;
  invalidateOwner(capture: ScopeCapture): Promise<CacheResult<undefined>>;
  clear(): Promise<CacheResult<undefined>>;
  clearHistory(): Promise<CacheResult<undefined>>;
  subscribe(
    listener: (event: CacheInvalidation, source: "local" | "remote") => void,
  ): () => void;
  close(): void;
}
