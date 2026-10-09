import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  AttachmentOutcomeSchema,
  type ReserveAttachment,
} from "@vaskel/contracts/attachments";
import type { MessageDO } from "@/server/actors/shared/message-do";
import type { Principal } from "@/server/domain/principal";
import { storageObservation } from "@/server/actors/shared/attachments/types";

/** A successful actor upload; partial and failed settlements stay in their cases. */
export async function readyAttachment(
  owner: DurableObjectStub<MessageDO>,
  principal: Principal,
  command: ReserveAttachment,
) {
  const reservation = AttachmentOutcomeSchema.parse(
    await owner.reserveAttachment(principal, command),
  );
  if (reservation.kind !== "attachment_reserved")
    throw new Error(`Reserve: ${reservation.kind}`);
  const begun = await owner.beginAttachmentUpload(
    principal,
    reservation.fileId,
  );
  if (begun.kind !== "attachment_upload")
    throw new Error(`Begin: ${begun.kind}`);
  const { upload } = begun;
  const object = await env.ATTACHMENTS.put(
    upload.objectKey,
    new Uint8Array([1, 2, 3]),
    {
      customMetadata: { fileId: upload.fileId, generation: upload.generation },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  if (!object) throw new Error("R2 create failed");
  expect(
    await owner.completeAttachmentUpload(principal, upload, {
      kind: "stored",
      object: storageObservation(object),
    }),
  ).toMatchObject({ kind: "attachment_ready" });
  return { ...reservation, command, upload, object };
}
