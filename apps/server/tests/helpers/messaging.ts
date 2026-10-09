import {
  MessagingOutcomeSchema,
  type MessagingOutcome,
} from "@vaskel/contracts/messaging";

export function acceptedMessage(result: MessagingOutcome) {
  const outcome = MessagingOutcomeSchema.parse(result);
  if (outcome.kind !== "accepted")
    throw new Error("Expected accepted: " + outcome.kind);
  return outcome.receipt;
}

export function messageEnvelope(channelId: string) {
  return { channelId, commandId: crypto.randomUUID(), issuedAt: Date.now() };
}
