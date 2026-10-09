import type {
  MessagingOutcome,
  OwnerScope,
  QuoteReference,
  SendMessage,
} from "@vaskel/contracts/messaging";
import type { ownerStub } from "@/server/directory/owners";
import type { Principal } from "@/server/domain/principal";
import type { CapturedQuote } from "@/server/actors/shared/quotes";
import { offerCommittedNotification } from "@/server/notifications/offers";

type Owner = ReturnType<typeof ownerStub>;
interface SendRequest {
  env: Env;
  waitUntil: (work: Promise<unknown>) => void;
  target: { owner: OwnerScope; stub: Pick<Owner, "prepareSend" | "send"> };
  principal: Principal;
  senderLabel?: string;
  command: SendMessage;
  source: (
    reference: QuoteReference,
  ) => Promise<Pick<Owner, "captureQuote"> | null>;
  refreshPrincipal: () => Promise<Principal | null>;
}

/** Only cross-owner text capture adds I/O to ordinary Send. No files cross this seam. */
export async function sendMessage(
  input: SendRequest,
): Promise<MessagingOutcome> {
  const { target, principal, command } = input;
  const send = async (
    current: Principal,
    capture?: CapturedQuote,
  ): Promise<MessagingOutcome> => {
    const { notification, outcome } = await target.stub.send(
      current,
      command,
      capture,
      input.senderLabel,
    );
    if (notification)
      input.waitUntil(offerCommittedNotification(input.env, notification));
    return outcome;
  };
  if (
    !command.quote ||
    (command.quote.owner.kind === target.owner.kind &&
      command.quote.owner.id === target.owner.id)
  )
    return send(principal);
  const admitted = await target.stub.prepareSend(principal, command);
  if (admitted.kind !== "send_admitted") return admitted;
  const source = await input.source(command.quote);
  if (!source) return { kind: "source_unavailable" };
  const captured = await source.captureQuote(principal, command.quote);
  if (captured.kind !== "quote_captured") return captured;
  const fresh = await input.refreshPrincipal();
  if (
    !fresh ||
    fresh.userId !== principal.userId ||
    fresh.sessionId !== principal.sessionId
  )
    return { kind: "unauthenticated" };
  // Source capture authorized sharing this snapshot; only the target owns acceptance.
  return send(fresh, captured.capture);
}
