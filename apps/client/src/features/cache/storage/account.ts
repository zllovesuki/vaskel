import type { AccountPreferences } from "@vaskel/contracts/preferences";
import {
  CacheMetaSchema,
  HISTORY_BYTE_LIMIT,
  HISTORY_CHANNEL_LIMIT,
  type AccountCapture,
  type AccountFence,
  type CacheInvalidation,
  type CacheMeta,
  type CacheResult,
  type CachedAccount,
  type DisplayLanguageHint,
} from "@/client/features/cache/model";
import {
  type CacheTransaction,
  ok,
  stale,
  invalid,
  StorageFailure,
  metaRecord,
  accountMatches,
  accountCapture,
  emptyMeta,
} from "./database";
import { snapshotRows, readDisplayLanguage } from "./queries";
import { payloadBytes, applyBounds } from "./retention";

export async function captureAccount(
  origin: string,
  tx: CacheTransaction,
): Promise<CacheResult<AccountCapture>> {
  const store = tx.meta;
  let meta = metaRecord(await store.get("current"));
  if (!meta) {
    meta = emptyMeta();
    await tx.scopes.clear();
    await tx.snapshots.clear();
    await tx.drafts.clear();
    await tx.draftFiles.clear();
    await tx.draftOwners.clear();
    await store.delete("display-language");
    await store.put(meta, "current");
  }
  return ok(accountCapture(meta, origin));
}

export async function activateAccount(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  capture: AccountCapture,
  account: { accountId: string; label: string },
): Promise<CacheResult<AccountFence>> {
  const store = tx.meta;
  const meta = metaRecord(await store.get("current"));
  if (!accountMatches(meta, capture, origin)) return stale();
  const changed = meta.accountId !== account.accountId;
  const next: CacheMeta = {
    ...meta,
    accountEpoch: changed ? crypto.randomUUID() : meta.accountEpoch,
    accountId: account.accountId,
    accountLabel: account.label,
  };
  if (!CacheMetaSchema.safeParse(next).success) return invalid();
  if (changed) {
    events.push({ type: "account", ...accountCapture(meta, origin) });
    await tx.scopes.clear();
    await tx.snapshots.clear();
    await tx.drafts.clear();
    await tx.draftFiles.clear();
    await tx.draftOwners.clear();
    await store.delete("display-language");
  }
  await store.put(next, "current");
  await applyBounds(origin, tx, next, events);
  return ok({
    ...accountCapture(next, origin),
    accountId: account.accountId,
  });
}

export async function saveDisplayLanguage(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  fence: AccountFence,
  preferences: AccountPreferences,
  hint: DisplayLanguageHint,
): Promise<CacheResult<undefined>> {
  const store = tx.meta;
  const meta = metaRecord(await store.get("current"));
  if (!accountMatches(meta, fence, origin)) return stale();
  const previous = await readDisplayLanguage(origin, tx, meta);
  if (previous && previous.revision >= preferences.revision)
    return previous.revision === preferences.revision &&
      previous.language === preferences.language
      ? ok(undefined)
      : stale();
  await store.put(hint, "display-language");
  await applyBounds(origin, tx, meta, events);
  return ok(undefined);
}

export async function readAccount(
  origin: string,
  tx: CacheTransaction,
): Promise<CacheResult<CachedAccount>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!meta?.accountId || !meta.accountLabel) return { kind: "miss" };
  const rows = await snapshotRows(origin, tx, meta);
  if (rows.length === 0) return { kind: "miss" };
  if (
    rows.length > HISTORY_CHANNEL_LIMIT ||
    (await payloadBytes(
      origin,
      tx,
      meta,
      rows.map((row) => ({
        key: row.key,
        byteLength: row.value.byteLength,
      })),
    )) > HISTORY_BYTE_LIMIT
  )
    throw new StorageFailure("corrupt");
  const displayLanguage = await readDisplayLanguage(origin, tx, meta);
  return ok({
    accountId: meta.accountId,
    label: meta.accountLabel,
    fence: {
      ...accountCapture(meta, origin),
      accountId: meta.accountId,
    },
    snapshots: rows
      .map((row) => row.value)
      .sort((a, b) => b.savedAt - a.savedAt),
    ...(displayLanguage ? { displayLanguage } : {}),
  });
}

export async function invalidateAccount(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  capture: AccountCapture,
): Promise<CacheResult<undefined>> {
  const store = tx.meta;
  const meta = metaRecord(await store.get("current"));
  if (!accountMatches(meta, capture, origin)) return stale();
  await tx.scopes.clear();
  await tx.snapshots.clear();
  await tx.drafts.clear();
  await tx.draftFiles.clear();
  await tx.draftOwners.clear();
  await store.delete("display-language");
  await store.put(
    {
      ...meta,
      accountEpoch: crypto.randomUUID(),
      accountId: null,
      accountLabel: null,
    },
    "current",
  );
  events.push({ type: "account", ...capture });
  return ok(undefined);
}

export async function clear(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
): Promise<CacheResult<undefined>> {
  const store = tx.meta;
  const previous = await store.get("current");
  const parsed = CacheMetaSchema.safeParse(previous);
  const meta = parsed.success ? parsed.data : emptyMeta();
  await tx.snapshots.clear();
  await tx.scopes.clear();
  await tx.drafts.clear();
  await tx.draftFiles.clear();
  await tx.draftOwners.clear();
  await store.clear();
  await store.put(
    {
      ...meta,
      accountEpoch: crypto.randomUUID(),
      accountId: null,
      accountLabel: null,
    },
    "current",
  );
  events.push(
    parsed.success
      ? { type: "account", ...accountCapture(meta, origin) }
      : { type: "cache", origin: origin },
  );
  return ok(undefined);
}

/** User-requested history removal leaves authored drafts and the account fence intact. */
export async function clearHistory(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
): Promise<CacheResult<undefined>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!meta) return ok(undefined);
  const scopes = await tx.scopes.toCollection().primaryKeys();
  for (const key of scopes) {
    const scope = await tx.scopes.get(key);
    if (scope && meta.accountId)
      events.push({
        type: "evicted",
        ...accountCapture(meta, origin),
        accountId: meta.accountId,
        owner: { kind: key[1], id: key[2] },
        scopeEpoch: scope.scopeEpoch,
        generation: scope.generation,
        retirementRevision: meta.retirementRevision,
      });
  }
  await tx.snapshots.clear();
  await tx.scopes.clear();
  meta.retirementRevision++;
  await tx.meta.put(meta, "current");
  return ok(undefined);
}
