import { z } from "zod";
import {
  OwnerScopeSchema,
  QuoteReferenceSchema,
  SendMessageSchema,
} from "@vaskel/contracts/messaging";
import {
  AttachmentDescriptorSchema,
  MESSAGE_ATTACHMENT_LIMIT,
} from "@vaskel/contracts/attachments";
import {
  AccountFenceSchema,
  type AccountFence,
  type CacheResult,
} from "@/client/features/cache/model";
import type { OwnerScope } from "@vaskel/contracts/messaging";

export const DraftTargetSchema = z.strictObject({
  owner: OwnerScopeSchema,
  channelId: z.string().min(1).max(128),
  label: z.string().max(512),
});
export type DraftTarget = z.infer<typeof DraftTargetSchema>;
export const DraftFenceSchema = AccountFenceSchema.extend({
  owner: OwnerScopeSchema,
  epoch: z.uuid(),
});
export type DraftFence = z.infer<typeof DraftFenceSchema>;
export const SavedUploadSchema = z.strictObject({
  id: z.uuid(),
  reservation: z.strictObject({
    commandId: z.uuid(),
    issuedAt: z.number().int().nonnegative(),
  }),
  fileId: z.uuid().optional(),
  attachment: AttachmentDescriptorSchema.optional(),
});
export type SavedUpload = z.infer<typeof SavedUploadSchema>;
export const DraftRecordSchema = z.strictObject({
  id: z.uuid(),
  target: DraftTargetSchema,
  selectedAt: z.number().nonnegative(),
  text: z.strictObject({
    body: z.string().max(128_000),
    mentions: z
      .array(
        z.strictObject({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          userId: z.string(),
        }),
      )
      .max(4_000),
  }),
  quote: QuoteReferenceSchema.nullable(),
  files: z.array(SavedUploadSchema).max(MESSAGE_ATTACHMENT_LIMIT),
  attempt: SendMessageSchema.nullable(),
});
export type DraftRecord = z.infer<typeof DraftRecordSchema>;
export type StoredDraft = { fence: DraftFence; record: DraftRecord };
export interface DraftPersistence {
  targets(account: AccountFence): Promise<CacheResult<DraftTarget[]>>;
  load(
    account: AccountFence,
    target: DraftTarget,
  ): Promise<CacheResult<{ fence: DraftFence; records: DraftRecord[] }>>;
  restore(
    fence: DraftFence,
    id: string,
  ): Promise<CacheResult<{ record: DraftRecord; files: Map<string, File> }>>;
  save(
    fence: DraftFence,
    record: DraftRecord,
    files: ReadonlyMap<string, File>,
  ): Promise<CacheResult<undefined>>;
  remove(fence: DraftFence, id: string): Promise<CacheResult<undefined>>;
  retire(
    account: AccountFence,
    owner: OwnerScope,
  ): Promise<CacheResult<undefined>>;
}
export const draftTargetKey = (
  target: Pick<DraftTarget, "owner" | "channelId">,
) => JSON.stringify([target.owner.kind, target.owner.id, target.channelId]);
