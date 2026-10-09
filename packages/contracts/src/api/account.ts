import { commandErrors, errorsFor } from "./errors";
import { z } from "zod";
import { account, resource, afterQuery, empty } from "./base";
import { outcome } from "./outcome";
import { OwnerScopeSchema } from "../messaging";
import {
  ActivityPageSchema,
  ActivityRequestSchema,
  OwnerActivityOutcomeSchema,
} from "../activity";
import {
  UpdateAccountPreferencesRequestSchema,
  UpdateAccountPreferencesResponseSchema,
} from "../preferences";
import { CrossSearchRequestSchema, CrossSearchResponseSchema } from "../search";
import { PresenceRequestSchema, PresenceOutcomeSchema } from "../presence";
import {
  NotificationCommandSchema,
  NotificationOutcomeSchema,
} from "../notifications";
import { AccountEventOutcomeSchema } from "../account-events";
import {
  BlockListSchema,
  BlockOutcomeSchema,
  BlockStatusesSchema,
  ResolveBlocksSchema,
  SetBlockSchema,
} from "../blocking";
const blocks = account.errors(commandErrors);
const targetParams = z.object({ targetId: z.uuid() });
export const accountApiContract = {
  activity: account
    .route({
      method: "GET",
      path: "/account/activity",
      inputStructure: "detailed",
    })
    .input(z.object({ query: ActivityRequestSchema }))
    .output(outcome(ActivityPageSchema, "activity")),
  ownerActivity: resource
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}/activity",
      inputStructure: "detailed",
    })
    .input(z.object({ params: OwnerScopeSchema, query: ActivityRequestSchema }))
    .output(outcome(OwnerActivityOutcomeSchema, "owner_activity")),
  preferences: account
    .route({
      method: "POST",
      path: "/account/preferences",
      inputStructure: "detailed",
    })
    .input(z.object({ body: UpdateAccountPreferencesRequestSchema }))
    .output(
      outcome(UpdateAccountPreferencesResponseSchema, "preferences_updated"),
    ),
  search: account
    .errors(errorsFor("QUERY_TOO_SHORT"))
    .meta({ freshness: "search" })
    .route({
      method: "POST",
      path: "/account/search",
      inputStructure: "detailed",
    })
    .input(z.object({ body: CrossSearchRequestSchema }))
    .output(outcome(CrossSearchResponseSchema, "cross_matches")),
  presence: account
    .route({
      method: "POST",
      path: "/account/presence",
      inputStructure: "detailed",
    })
    .input(z.object({ body: PresenceRequestSchema }))
    .output(outcome(PresenceOutcomeSchema, "presence")),
  notifications: account
    .route({ method: "GET", path: "/notifications" })
    .input(empty)
    .output(outcome(NotificationOutcomeSchema, "notification_state")),
  notificationCommand: account
    .errors(commandErrors)
    .route({
      method: "POST",
      path: "/notifications/commands",
      inputStructure: "detailed",
    })
    .input(z.object({ body: NotificationCommandSchema }))
    .output(outcome(NotificationOutcomeSchema, "notification_updated")),
  accountEventTicket: account
    .route({ method: "POST", path: "/account/events/ticket" })
    .input(empty)
    .output(outcome(AccountEventOutcomeSchema, "event_ticket")),
  blocks: blocks
    .route({
      method: "GET",
      path: "/account/blocks",
      inputStructure: "detailed",
    })
    .input(z.object({ query: afterQuery }))
    .output(outcome(BlockListSchema, "blocks")),
  resolveBlocks: blocks
    .route({
      method: "POST",
      path: "/account/blocks/resolve",
      inputStructure: "detailed",
    })
    .input(z.object({ body: ResolveBlocksSchema }))
    .output(outcome(BlockStatusesSchema, "block_statuses")),
  blockStatus: blocks
    .route({
      method: "GET",
      path: "/account/blocks/{targetId}",
      inputStructure: "detailed",
    })
    .input(z.object({ params: targetParams }))
    .output(outcome(BlockOutcomeSchema, "block_status")),
  updateBlock: blocks
    .route({
      method: "PUT",
      path: "/account/blocks/{targetId}",
      inputStructure: "detailed",
    })
    .input(z.object({ params: targetParams, body: SetBlockSchema }))
    .output(outcome(BlockOutcomeSchema, "block_updated")),
  directStatus: resource
    .route({
      method: "GET",
      path: "/resources/{kind}/{id}/direct-status",
      inputStructure: "detailed",
    })
    .input(
      z.object({
        params: z.object({ kind: z.literal("conversation"), id: z.uuid() }),
      }),
    )
    .output(outcome(BlockOutcomeSchema, "block_status")),
};
