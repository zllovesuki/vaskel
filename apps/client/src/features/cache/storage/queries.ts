import {
  CachedSnapshotSchema,
  DisplayLanguageHintSchema,
  HISTORY_CHANNEL_LIMIT,
  type CacheMeta,
  type CacheScope,
  type CachedSnapshot,
  type DisplayLanguageHint,
} from "@/client/features/cache/model";
import {
  type ScopeKey,
  type SnapshotKey,
  type CacheTransaction,
  PENDING_SCOPE_LIMIT,
  ScopeKeySchema,
  SnapshotKeySchema,
  RetentionKeySchema,
  type SnapshotMetadata,
  encodedBytes,
  equalKey,
  snapshotKey,
  StorageFailure,
  scopeRecord,
  accountMatches,
  scopeMatches,
} from "./database";

export async function deleteOwnerSnapshots(
  tx: CacheTransaction,
  key: ScopeKey,
) {
  await tx.snapshots
    .where(":id")
    .between(key, [...key, []], true, true)
    .delete();
}

export function snapshotRecord(
  origin: string,
  raw: unknown,
  key: SnapshotKey,
  meta: CacheMeta,
  scope: CacheScope,
): CachedSnapshot {
  const parsed = CachedSnapshotSchema.safeParse(raw);
  if (
    !parsed.success ||
    !accountMatches(meta, parsed.data.fence, origin) ||
    !scopeMatches(scope, parsed.data.fence) ||
    !scope.eligible ||
    !equalKey(key, snapshotKey(parsed.data.fence, parsed.data.cursor.channelId))
  )
    throw new StorageFailure("corrupt");
  return parsed.data;
}

export async function snapshotRows(
  origin: string,
  tx: CacheTransaction,
  meta: CacheMeta,
): Promise<{ key: SnapshotKey; value: CachedSnapshot }[]> {
  const store = tx.snapshots;
  if ((await store.count()) > HISTORY_CHANNEL_LIMIT + 1)
    throw new StorageFailure("corrupt");
  const rows: { key: SnapshotKey; value: CachedSnapshot }[] = [];
  const keys = (await store.toCollection().primaryKeys()).map((key) => {
    const parsed = SnapshotKeySchema.safeParse(key);
    if (!parsed.success) throw new StorageFailure("corrupt");
    return parsed.data;
  });
  const values = await store.bulkGet(keys);
  const scopes = await tx.scopes.bulkGet(
    keys.map((key) => [key[0], key[1], key[2]]),
  );
  for (const [index, key] of keys.entries()) {
    const scope = scopeRecord(scopes[index]);
    if (!scope) throw new StorageFailure("corrupt");
    rows.push({
      key,
      value: snapshotRecord(origin, values[index], key, meta, scope),
    });
  }
  return rows;
}

export async function scopeRows(
  tx: CacheTransaction,
): Promise<{ key: ScopeKey; value: CacheScope }[]> {
  const store = tx.scopes;
  if ((await store.count()) > HISTORY_CHANNEL_LIMIT + PENDING_SCOPE_LIMIT + 1)
    throw new StorageFailure("corrupt");
  const rows: { key: ScopeKey; value: CacheScope }[] = [];
  await store.each((raw, cursor) => {
    const key = ScopeKeySchema.safeParse(cursor.primaryKey);
    const value = scopeRecord(raw);
    if (!key.success || !value) throw new StorageFailure("corrupt");
    rows.push({ key: key.data, value });
  });
  return rows;
}

export async function readDisplayLanguage(
  origin: string,
  tx: CacheTransaction,
  meta: CacheMeta,
): Promise<DisplayLanguageHint | undefined> {
  const store = tx.meta;
  const raw = await store.get("display-language");
  if (raw === undefined) return undefined;
  const parsed = DisplayLanguageHintSchema.safeParse(raw);
  if (!parsed.success || !accountMatches(meta, parsed.data.fence, origin)) {
    // Bad display metadata must not revoke otherwise valid retained history.
    await store.delete("display-language");
    return undefined;
  }
  return parsed.data;
}

export async function displayLanguageBytes(
  origin: string,
  tx: CacheTransaction,
  meta: CacheMeta,
) {
  const hint = await readDisplayLanguage(origin, tx, meta);
  return hint ? encodedBytes("display-language") + encodedBytes(hint) : 0;
}

export async function snapshotMetadata(
  tx: CacheTransaction,
  meta: CacheMeta,
): Promise<SnapshotMetadata[]> {
  const store = tx.snapshots;
  const count = await store.count();
  if (count > HISTORY_CHANNEL_LIMIT + 1) throw new StorageFailure("corrupt");
  const rows: SnapshotMetadata[] = [];
  await store.orderBy("[savedAt+byteLength]").eachKey((indexKey, cursor) => {
    const key = SnapshotKeySchema.safeParse(cursor.primaryKey);
    const retained = RetentionKeySchema.safeParse(indexKey);
    if (!key.success || !retained.success || key.data[0] !== meta.accountId)
      throw new StorageFailure("corrupt");
    rows.push({
      key: key.data,
      savedAt: retained.data[0],
      byteLength: retained.data[1],
    });
  });
  if (rows.length !== count) throw new StorageFailure("corrupt");
  return rows;
}
