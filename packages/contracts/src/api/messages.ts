import { z } from "zod";
import { resource } from "./base";
import { outcome } from "./outcome";
import {
  AroundRequestSchema,
  DeleteMessageSchema,
  EditMessageSchema,
  MessagingOutcomeSchema,
  OriginalMessageOutcomeSchema,
  OriginalMessageRequestSchema,
  OwnerScopeSchema,
  PrepareSocketSchema,
  ReactMessageSchema,
  ReadRequestSchema,
  RemoveMessageAttachmentSchema,
  RenewSocketSchema,
  ReplayRequestSchema,
  SearchRequestSchema,
  SendMessageSchema,
  SnapshotRequestSchema,
} from "../messaging";
import { DirectoryOutcomeSchema, MembersOutcomeSchema } from "../resources";
export const messageApiContract = {
  resource: resource
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema }))
    .output(outcome(DirectoryOutcomeSchema, "directory")),
  send: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/send",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: SendMessageSchema }))
    .output(outcome(MessagingOutcomeSchema, "accepted")),
  socketTicket: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/socket-ticket",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: PrepareSocketSchema }))
    .output(outcome(MessagingOutcomeSchema, "socket_ticket")),
  socketRenew: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/socket-renew",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: RenewSocketSchema }))
    .output(outcome(MessagingOutcomeSchema, "socket_renewed")),
  members: resource
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}/members",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema }))
    .output(outcome(MembersOutcomeSchema, "members")),
  snapshot: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/snapshot",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: SnapshotRequestSchema }))
    .output(outcome(MessagingOutcomeSchema, "snapshot")),
  react: resource
    .meta({ authority: "message" })
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/react",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: ReactMessageSchema }))
    .output(outcome(MessagingOutcomeSchema, "accepted")),
  around: resource
    .meta({ authority: "message" })
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/around",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: AroundRequestSchema }))
    .output(outcome(MessagingOutcomeSchema, "around")),
  edit: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/edit",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: EditMessageSchema }))
    .output(outcome(MessagingOutcomeSchema, "accepted")),
  deleteMessage: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/delete",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: DeleteMessageSchema }))
    .output(outcome(MessagingOutcomeSchema, "accepted")),
  removeAttachment: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/remove-attachment",
      inputStructure: "detailed",
    })
    .input(
      z.object({
        params: OwnerScopeSchema,
        body: RemoveMessageAttachmentSchema,
      }),
    )
    .output(outcome(MessagingOutcomeSchema, "accepted")),
  originalMessage: resource
    .meta({ authority: "capability" })
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/original-message",
      inputStructure: "detailed",
    })
    .input(
      z.object({
        params: OwnerScopeSchema,
        body: OriginalMessageRequestSchema,
      }),
    )
    .output(outcome(OriginalMessageOutcomeSchema, "original_message")),
  replay: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/replay",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: ReplayRequestSchema }))
    .output(outcome(MessagingOutcomeSchema, "replay")),
  searchMessages: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/search",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: SearchRequestSchema }))
    .output(outcome(MessagingOutcomeSchema, "matches")),
  updateRead: resource
    .route({
      method: "POST",
      path: "/resources/{kind}/{id}/read",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, body: ReadRequestSchema }))
    .output(outcome(MessagingOutcomeSchema, "read_updated")),
};
