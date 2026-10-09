import Dexie, { type Table } from "dexie";
import type { StoredDraft } from "@/client/features/drafts/model";
import { z } from "zod";
import { OwnerScopeSchema, type OwnerScope } from "@vaskel/contracts/messaging";
import {
  CacheMetaSchema,
  CacheScopeSchema,
  HISTORY_BYTE_LIMIT,
  HISTORY_CHANNEL_LIMIT,
  HISTORY_FORMAT,
  HISTORY_DATABASE,
  type AccountCapture,
  type AccountFence,
  type CacheMeta,
  type CacheResult,
  type CacheScope,
  type CacheUnavailableReason,
  type CachedSnapshot,
  type HistoryFence,
  type DisplayLanguageHint,
  type ScopeCapture,
} from "@/client/features/cache/model";

export type ScopeKey = [string, OwnerScope["kind"], string];

export type SnapshotKey = [string, OwnerScope["kind"], string, string, string];

/** Out-of-line keys keep File bytes separate from small validated records. */
export interface CacheTables {
  drafts: Table<StoredDraft, [string, string]>;
  draftFiles: Table<File, [string, string, string]>;
  draftOwners: Table<string, ScopeKey>;
  meta: Table<CacheMeta | DisplayLanguageHint, "current" | "display-language">;
  scopes: Table<CacheScope, ScopeKey>;
  snapshots: Table<CachedSnapshot, SnapshotKey>;
}

export class CacheDatabase extends Dexie implements CacheTables {
  declare drafts: CacheTables["drafts"];
  declare draftFiles: CacheTables["draftFiles"];
  declare draftOwners: CacheTables["draftOwners"];
  declare meta: CacheTables["meta"];
  declare scopes: CacheTables["scopes"];
  declare snapshots: CacheTables["snapshots"];

  constructor() {
    super(HISTORY_DATABASE, {
      autoOpen: false,
      chromeTransactionDurability: "strict",
    });
    this.version(1).stores({
      meta: "",
      scopes: "",
      snapshots: ",[savedAt+byteLength]",
      drafts: "",
      draftFiles: "",
      draftOwners: "",
    });
  }
}

export const draftStores: (keyof CacheTables)[] = [
  "meta",
  "drafts",
  "draftFiles",
  "draftOwners",
];

/** Table operations inherit the enclosing Dexie transaction; no nested transactions. */
export type CacheTransaction = CacheTables;

export const OPEN_TIMEOUT_MS = 2_000;

export const PENDING_SCOPE_LIMIT = HISTORY_CHANNEL_LIMIT;

export const identifier = z.string().min(1).max(128);

export const ScopeKeySchema = z.tuple([
  identifier,
  OwnerScopeSchema.shape.kind,
  identifier,
]);

export const SnapshotKeySchema = z.tuple([
  identifier,
  OwnerScopeSchema.shape.kind,
  identifier,
  identifier,
  z.uuid(),
]);

export const RetentionKeySchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().min(1).max(HISTORY_BYTE_LIMIT),
]);

export interface SnapshotMetadata {
  key: SnapshotKey;
  savedAt: number;
  byteLength: number;
}

export function ok<T>(value: T): CacheResult<T> {
  return { kind: "ok", value };
}

export const stale = (): CacheResult<never> => ({ kind: "stale" });

export const invalid = (): CacheResult<never> => ({
  kind: "unavailable",
  reason: "invalid-record",
});

export const encodedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const equalKey = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export const scopeKey = (fence: AccountFence, owner: OwnerScope): ScopeKey => [
  fence.accountId,
  owner.kind,
  owner.id,
];

export const snapshotKey = (
  fence: HistoryFence,
  channelId: string,
): SnapshotKey => [
  ...scopeKey(fence, fence.owner),
  channelId,
  fence.generation,
];

export class StorageFailure extends Error {
  constructor(readonly reason: CacheUnavailableReason) {
    super(reason);
  }
}

export function failureReason(error: unknown): CacheUnavailableReason {
  if (error instanceof StorageFailure) return error.reason;
  return error instanceof Error && error.name === "QuotaExceededError"
    ? "quota"
    : "storage";
}

export function metaRecord(value: unknown): CacheMeta | undefined {
  if (value === undefined) return undefined;
  const parsed = CacheMetaSchema.safeParse(value);
  if (!parsed.success) throw new StorageFailure("corrupt");
  return parsed.data;
}

export function scopeRecord(value: unknown): CacheScope | undefined {
  if (value === undefined) return undefined;
  const parsed = CacheScopeSchema.safeParse(value);
  if (!parsed.success) throw new StorageFailure("corrupt");
  return parsed.data;
}

export function accountMatches(
  meta: CacheMeta | undefined,
  capture: AccountCapture,
  origin: string,
): meta is CacheMeta {
  return (
    !!meta &&
    capture.origin === origin &&
    meta.cacheId === capture.cacheId &&
    meta.accountEpoch === capture.accountEpoch &&
    meta.accountId === capture.accountId
  );
}

export function scopeMatches(
  scope: CacheScope | undefined,
  capture: ScopeCapture,
): scope is CacheScope {
  return (
    !!scope &&
    scope.scopeEpoch === capture.scopeEpoch &&
    scope.generation === capture.generation
  );
}

export function accountCapture(
  meta: CacheMeta,
  origin: string,
): AccountCapture {
  return {
    origin,
    cacheId: meta.cacheId,
    accountEpoch: meta.accountEpoch,
    accountId: meta.accountId,
  };
}

export function emptyMeta(): CacheMeta {
  return {
    format: HISTORY_FORMAT,
    retirementRevision: 0,
    cacheId: crypto.randomUUID(),
    accountEpoch: crypto.randomUUID(),
    accountId: null,
    accountLabel: null,
  };
}
