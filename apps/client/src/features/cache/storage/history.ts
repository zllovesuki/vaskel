import type { OwnerScope } from "@vaskel/contracts/messaging";
import {
  HISTORY_BYTE_LIMIT,
  HISTORY_CHANNEL_LIMIT,
  type AccountCapture,
  type AccountFence,
  type CacheInvalidation,
  type CacheResult,
  type CachedSnapshot,
  type HistoryFence,
  type HistoryProjection,
  type ScopeCapture,
} from "@/client/features/cache/model";
import { prepareSnapshot } from "@/client/features/cache/records";
import {
  type CacheTransaction,
  ok,
  stale,
  equalKey,
  scopeKey,
  snapshotKey,
  StorageFailure,
  metaRecord,
  scopeRecord,
  accountMatches,
  scopeMatches,
} from "./database";
import {
  deleteOwnerSnapshots,
  snapshotRecord,
  snapshotMetadata,
} from "./queries";
import { boundPendingScopes, payloadBytes, applyBounds } from "./retention";

export async function captureScope(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  account: AccountFence,
  owner: OwnerScope,
): Promise<CacheResult<ScopeCapture>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, account, origin)) return stale();
  const key = scopeKey(account, owner);
  const store = tx.scopes;
  let scope = scopeRecord(await store.get(key));
  if (!scope) {
    scope = {
      scopeEpoch: crypto.randomUUID(),
      generation: null,
      eligible: false,
    };
    await store.put(scope, key);
    await boundPendingScopes(tx, account, meta.retirementRevision, key, events);
    await applyBounds(origin, tx, meta, events);
  }
  return ok({
    ...account,
    owner,
    scopeEpoch: scope.scopeEpoch,
    generation: scope.generation,
    retirementRevision: meta.retirementRevision,
  });
}

export async function authorizeScope(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  capture: ScopeCapture,
  generation: string,
): Promise<CacheResult<HistoryFence>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, capture, origin)) return stale();
  const key = scopeKey(capture, capture.owner);
  const store = tx.scopes;
  const previous = scopeRecord(await store.get(key));
  if (!scopeMatches(previous, capture)) return stale();
  let epoch = previous.scopeEpoch;
  if (previous.generation !== null && previous.generation !== generation) {
    await deleteOwnerSnapshots(tx, key);
    events.push({ type: "owner", ...capture });
    meta.retirementRevision++;
    await tx.meta.put(meta, "current");
    epoch = crypto.randomUUID();
  }
  await store.put({ scopeEpoch: epoch, generation, eligible: true }, key);
  await applyBounds(origin, tx, meta, events);
  return ok({
    ...capture,
    generation,
    scopeEpoch: epoch,
    retirementRevision: meta.retirementRevision,
  });
}

export async function save(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  fence: HistoryFence,
  projection: HistoryProjection,
  options: { replace: boolean },
): Promise<CacheResult<CachedSnapshot>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, fence, origin)) return stale();
  const scope = scopeRecord(await tx.scopes.get(scopeKey(fence, fence.owner)));
  if (!scopeMatches(scope, fence) || !scope.eligible) return stale();
  const store = tx.snapshots;
  const key = snapshotKey(fence, projection.cursor.channelId);
  const rawPrevious = await store.get(key);
  const previous =
    rawPrevious === undefined
      ? undefined
      : snapshotRecord(origin, rawPrevious, key, meta, scope);
  const result = prepareSnapshot(
    fence,
    projection,
    previous,
    options.replace,
    Date.now(),
  );
  if (result.kind !== "ok") return result;
  await store.put(result.value, key);
  const retained = await applyBounds(origin, tx, meta, events);
  return retained.some((row) => equalKey(row.key, key))
    ? result
    : { kind: "miss" };
}

export async function readSnapshot(
  origin: string,
  tx: CacheTransaction,
  fence: HistoryFence,
  channelId: string,
): Promise<CacheResult<CachedSnapshot>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, fence, origin)) return stale();
  const scope = scopeRecord(await tx.scopes.get(scopeKey(fence, fence.owner)));
  if (!scopeMatches(scope, fence) || !scope.eligible) return stale();
  const metadata = await snapshotMetadata(tx, meta);
  if (
    metadata.length > HISTORY_CHANNEL_LIMIT ||
    (await payloadBytes(origin, tx, meta, metadata)) > HISTORY_BYTE_LIMIT
  )
    throw new StorageFailure("corrupt");
  const key = snapshotKey(fence, channelId);
  const value = await tx.snapshots.get(key);
  return value === undefined
    ? { kind: "miss" }
    : ok(snapshotRecord(origin, value, key, meta, scope));
}

export async function recheck(
  origin: string,
  tx: CacheTransaction,
  fence: AccountCapture | ScopeCapture,
): Promise<CacheResult<undefined>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, fence, origin)) return stale();
  if ("owner" in fence) {
    const scope = scopeRecord(
      await tx.scopes.get(scopeKey(fence, fence.owner)),
    );
    if (
      !scopeMatches(scope, fence) ||
      (fence.generation !== null && !scope.eligible)
    )
      // Missing/recreated cache metadata is harmless only when no actual
      // owner retirement has occurred since this lease. The account-wide
      // revision keeps this proof bounded even after scope metadata eviction.
      return fence.retirementRevision === meta.retirementRevision
        ? { kind: "miss" }
        : stale();
  }
  return ok(undefined);
}

export async function invalidateOwner(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  capture: ScopeCapture,
): Promise<CacheResult<undefined>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, capture, origin)) return stale();
  const key = scopeKey(capture, capture.owner);
  const scope = scopeRecord(await tx.scopes.get(key));
  if (scope && !scopeMatches(scope, capture)) return stale();
  await deleteOwnerSnapshots(tx, key);
  await tx.scopes.delete(key);
  meta.retirementRevision++;
  await tx.meta.put(meta, "current");
  events.push({ type: "owner", ...capture });
  return ok(undefined);
}
