import { z } from "zod";
import { resource } from "./base";
import { outcome } from "./outcome";
import { OwnerScopeSchema } from "../messaging";
import { OwnerCapacitySchema } from "../capacity";
import {
  AttachmentGrantSchema,
  AttachmentIncidentSchema,
  AttachmentOutcomeSchema,
  AttachmentStatusSchema,
  ReserveAttachmentSchema,
} from "../attachments";
export const fileParams = z.object({
  ...OwnerScopeSchema.shape,
  fileId: z.uuid(),
});
export const attachmentApiContract = {
  capacity: resource
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}/capacity",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema }))
    .output(OwnerCapacitySchema),
  reserveFile: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/files/reserve",
      inputStructure: "detailed",
    })
    .input(
      z.object({ params: OwnerScopeSchema, body: ReserveAttachmentSchema }),
    )
    .output(outcome(AttachmentOutcomeSchema, "attachment_reserved")),
  fileStatus: resource
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}/files/{fileId}/status",
      inputStructure: "detailed",
    })
    .input(z.object({ params: fileParams }))
    .output(AttachmentStatusSchema),
  cancelFile: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/files/{fileId}/cancel",
      inputStructure: "detailed",
    })
    .input(z.object({ params: fileParams }))
    .output(outcome(AttachmentOutcomeSchema, "attachment_canceled")),
  /** One signed byte URL per file; a missing or quarantined file fails locally, like a message read. */
  fileGrant: resource
    .meta({ authority: "message" })
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}/files/{fileId}/grant",
      inputStructure: "detailed",
    })
    .input(z.object({ params: fileParams }))
    .output(AttachmentGrantSchema),
  fileIncident: resource
    .meta({ authority: "capability" })
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/files/{fileId}/incident",
      inputStructure: "detailed",
    })
    .input(z.object({ params: fileParams, body: AttachmentIncidentSchema }))
    .output(outcome(AttachmentOutcomeSchema, "attachment_updated")),
};
