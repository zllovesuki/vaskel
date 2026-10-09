import {
  HISTORY_BYTE_LIMIT,
  HISTORY_CHANNEL_LIMIT,
  type AccountFence,
  type CacheInvalidation,
  type CacheMeta,
} from "@/client/features/cache/model";
import {
  type ScopeKey,
  type SnapshotKey,
  type CacheTransaction,
  PENDING_SCOPE_LIMIT,
  encodedBytes,
  equalKey,
  accountCapture,
} from "./database";
import { scopeRows, displayLanguageBytes, snapshotMetadata } from "./queries";

export async function boundPendingScopes(
  tx: CacheTransaction,
  account: AccountFence,
  retirementRevision: number,
  keep: ScopeKey,
  events: CacheInvalidation[],
) {
  const keys = await tx.snapshots.toCollection().primaryKeys();
  const pending = (await scopeRows(tx)).filter(
    (row) => !keys.some((key) => equalKey(key.slice(0, 3), row.key)),
  );
  while (pending.length > PENDING_SCOPE_LIMIT) {
    const index = pending.findIndex((row) => !equalKey(row.key, keep));
    const [removed] = pending.splice(index, 1);
    if (!removed) break;
    await tx.scopes.delete(removed.key);
    events.push({
      type: "evicted",
      ...account,
      owner: { kind: removed.key[1], id: removed.key[2] },
      retirementRevision,
      scopeEpoch: removed.value.scopeEpoch,
      generation: removed.value.generation,
    });
  }
}

export async function payloadBytes(
  origin: string,
  tx: CacheTransaction,
  meta: CacheMeta,
  rows: { key: SnapshotKey; byteLength: number }[],
): Promise<number> {
  return (
    encodedBytes(meta) +
    (await displayLanguageBytes(origin, tx, meta)) +
    rows.reduce((sum, row) => sum + encodedBytes(row.key) + row.byteLength, 0) +
    (await scopeRows(tx)).reduce(
      (sum, row) => sum + encodedBytes(row.key) + encodedBytes(row.value),
      0,
    )
  );
}

export async function applyBounds(
  origin: string,
  tx: CacheTransaction,
  meta: CacheMeta,
  events: CacheInvalidation[],
) {
  const rows = await snapshotMetadata(tx, meta);
  const scopes = await scopeRows(tx);
  let bytes =
    encodedBytes(meta) +
    (await displayLanguageBytes(origin, tx, meta)) +
    rows.reduce((sum, row) => sum + encodedBytes(row.key) + row.byteLength, 0) +
    scopes.reduce(
      (sum, row) => sum + encodedBytes(row.key) + encodedBytes(row.value),
      0,
    );
  while (rows.length > HISTORY_CHANNEL_LIMIT || bytes > HISTORY_BYTE_LIMIT) {
    const removed = rows.shift();
    if (!removed) break;
    await tx.snapshots.delete(removed.key);
    bytes -= encodedBytes(removed.key) + removed.byteLength;
    const ownerKey: ScopeKey = [removed.key[0], removed.key[1], removed.key[2]];
    if (!rows.some((row) => equalKey(row.key.slice(0, 3), ownerKey))) {
      await tx.scopes.delete(ownerKey);
      const scope = scopes.find((row) => equalKey(row.key, ownerKey));
      if (scope) {
        bytes -= encodedBytes(scope.key) + encodedBytes(scope.value);
        events.push({
          type: "evicted",
          ...accountCapture(meta, origin),
          accountId: ownerKey[0],
          owner: { kind: ownerKey[1], id: ownerKey[2] },
          retirementRevision: meta.retirementRevision,
          scopeEpoch: scope.value.scopeEpoch,
          generation: scope.value.generation,
        });
      }
    }
  }
  return rows;
}
