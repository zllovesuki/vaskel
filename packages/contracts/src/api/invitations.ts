import { identityErrors, messagingErrors, errorsFor } from "./errors";
import { z } from "zod";
import { operation, account } from "./base";
import { outcome, identityResult } from "./outcome";
import {
  AdministrationOutcomeSchema,
  InviteTokenSchema,
} from "../administration";
import {
  InviteRegistrationSchema,
  InviteRegistrationResponseSchema,
} from "../directory";
const invite = operation
  .errors(identityErrors)
  .errors(messagingErrors)
  .errors(errorsFor("CAPACITY", "NOT_FOUND"))
  .meta({ authority: "public" });
export const invitationApiContract = {
  inspectInvite: invite
    .route({
      method: "POST",
      path: "/invites/inspect",
      inputStructure: "detailed",
    })
    .input(z.object({ body: InviteTokenSchema }))
    .output(outcome(AdministrationOutcomeSchema, "invite_valid")),
  registerInvite: invite
    .route({
      method: "POST",
      path: "/invites/register",
      successStatus: 201,
      inputStructure: "detailed",
    })
    .input(z.object({ body: InviteRegistrationSchema }))
    .output(identityResult(InviteRegistrationResponseSchema, "registered")),
  joinInvite: account
    .errors(messagingErrors)
    .route({
      method: "POST",
      path: "/invites/join",
      inputStructure: "detailed",
    })
    .input(z.object({ body: InviteTokenSchema }))
    .output(outcome(AdministrationOutcomeSchema, "joined")),
};
