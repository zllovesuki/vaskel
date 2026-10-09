import type {
  AccountFence,
  CacheInvalidation,
  CacheResult,
} from "@/client/features/cache/model";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { ATTACHMENT_BYTE_LIMIT } from "@vaskel/contracts/attachments";
import {
  DraftRecordSchema,
  DraftFenceSchema,
  type DraftFence,
  type DraftRecord,
  type DraftTarget,
} from "@/client/features/drafts/model";
import {
  accountMatches,
  metaRecord,
  scopeKey,
  ok,
  stale,
  invalid,
  StorageFailure,
  type CacheTransaction,
} from "./database";

const DRAFT_LIMIT = 64;
const FILE_BYTE_LIMIT = 128 * 1_024 * 1_024;
const draftFiles = (tx: CacheTransaction, accountId: string, id: string) =>
  tx.draftFiles
    .where(":id")
    .between([accountId, id], [accountId, id, []], true, true);

async function valid(origin: string, tx: CacheTransaction, fence: DraftFence) {
  return (
    accountMatches(metaRecord(await tx.meta.get("current")), fence, origin) &&
    (await tx.draftOwners.get(scopeKey(fence, fence.owner))) === fence.epoch
  );
}
export async function load(
  origin: string,
  tx: CacheTransaction,
  account: AccountFence,
  target: DraftTarget,
) {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, account, origin)) return stale();
  const key = scopeKey(account, target.owner);
  let epoch = await tx.draftOwners.get(key);
  if (!epoch) {
    epoch = crypto.randomUUID();
    await tx.draftOwners.put(epoch, key);
  }
  const fence = { ...account, owner: target.owner, epoch };
  const rows = await tx.drafts.toArray();
  const records: DraftRecord[] = [];
  for (const row of rows) {
    const parsed = DraftRecordSchema.safeParse(row.record);
    const savedFence = DraftFenceSchema.safeParse(row.fence);
    if (!parsed.success || !savedFence.success)
      throw new StorageFailure("invalid-record");
    if (
      accountMatches(meta, savedFence.data, origin) &&
      savedFence.data.epoch === epoch &&
      parsed.data.target.owner.kind === target.owner.kind &&
      parsed.data.target.owner.id === target.owner.id &&
      parsed.data.target.channelId === target.channelId
    )
      records.push(parsed.data);
  }
  return ok({
    fence,
    records: records.sort((a, b) => b.selectedAt - a.selectedAt),
  });
}
export async function restore(
  origin: string,
  tx: CacheTransaction,
  fence: DraftFence,
  id: string,
): Promise<CacheResult<{ record: DraftRecord; files: Map<string, File> }>> {
  if (!(await valid(origin, tx, fence))) return stale();
  const stored = await tx.drafts.get([fence.accountId, id]);
  if (!stored) return { kind: "miss" };
  const record = DraftRecordSchema.parse(stored.record);
  const result = new Map<string, File>();
  await draftFiles(tx, fence.accountId, id).each((file, cursor) => {
    if (!(file instanceof File) || file.size > ATTACHMENT_BYTE_LIMIT)
      throw new StorageFailure("invalid-record");
    result.set(cursor.primaryKey[2], file);
  });
  return ok({ record, files: result });
}
export async function save(
  origin: string,
  tx: CacheTransaction,
  fence: DraftFence,
  record: DraftRecord,
  selected: ReadonlyMap<string, File>,
): Promise<CacheResult<undefined>> {
  if (!(await valid(origin, tx, fence))) return stale();
  const parsed = DraftRecordSchema.safeParse(record);
  if (
    !parsed.success ||
    record.target.owner.kind !== fence.owner.kind ||
    record.target.owner.id !== fence.owner.id
  )
    return invalid();
  const store = tx.drafts;
  const key: [string, string] = [fence.accountId, record.id];
  if (!(await store.get(key)) && (await store.count()) >= DRAFT_LIMIT)
    throw new StorageFailure("quota");
  const fileStore = tx.draftFiles;
  const retained = new Set(record.files.map((file) => file.id));
  const removed = (
    await draftFiles(tx, fence.accountId, record.id).primaryKeys()
  ).filter((key) => !retained.has(key[2]));
  await fileStore.bulkDelete(removed);
  let added = false;
  for (const file of record.files) {
    const key: [string, string, string] = [fence.accountId, record.id, file.id];
    if (await fileStore.where(":id").equals(key).count()) continue;
    const bytes = selected.get(file.id);
    if (!bytes || bytes.size > ATTACHMENT_BYTE_LIMIT)
      throw new StorageFailure("invalid-record");
    await fileStore.put(bytes, key);
    added = true;
  }
  if (added) {
    let bytes = 0;
    await fileStore.each((file) => {
      bytes += file.size;
      if (bytes > FILE_BYTE_LIMIT) throw new StorageFailure("quota");
    });
  }
  await store.put({ fence, record: parsed.data }, key);
  return ok(undefined);
}
export async function remove(
  origin: string,
  tx: CacheTransaction,
  fence: DraftFence,
  id: string,
): Promise<CacheResult<undefined>> {
  if (!(await valid(origin, tx, fence))) return stale();
  await tx.drafts.delete([fence.accountId, id]);
  await draftFiles(tx, fence.accountId, id).delete();
  return ok(undefined);
}
export async function retire(
  origin: string,
  tx: CacheTransaction,
  events: CacheInvalidation[],
  account: AccountFence,
  owner: OwnerScope,
): Promise<CacheResult<undefined>> {
  if (
    !accountMatches(metaRecord(await tx.meta.get("current")), account, origin)
  )
    return stale();
  const key = scopeKey(account, owner);
  await tx.draftOwners.put(crypto.randomUUID(), key);
  const keys = await tx.drafts
    .where(":id")
    .between([account.accountId], [account.accountId, []], true, true)
    .filter(
      (row) =>
        row.record.target.owner.kind === owner.kind &&
        row.record.target.owner.id === owner.id,
    )
    .primaryKeys();
  for (const key of keys)
    await draftFiles(tx, account.accountId, key[1]).delete();
  await tx.drafts.bulkDelete(keys);
  events.push({ type: "drafts_retired", ...account, owner });
  return ok(undefined);
}

export async function targets(
  origin: string,
  tx: CacheTransaction,
  account: AccountFence,
): Promise<CacheResult<DraftTarget[]>> {
  const meta = metaRecord(await tx.meta.get("current"));
  if (!accountMatches(meta, account, origin)) return stale();
  return ok(
    (await tx.drafts.toArray())
      .filter((row) => accountMatches(meta, row.fence, origin))
      .map((row) => DraftRecordSchema.parse(row.record).target),
  );
}
