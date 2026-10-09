import type { OwnerScope } from "@vaskel/contracts/messaging";

/** Private owner/Worker/account RPC data; never part of a browser response. */
export interface NotificationMessageReference {
  owner: OwnerScope;
  ownerGeneration: string;
  roomId: string;
  messageId: string;
  sequence: number;
  createdAt: number;
  senderLabel: string;
}

export interface CommittedNotificationOffer {
  recipients: string[];
  reference: NotificationMessageReference;
  /** The owner's post-commit budget is not restarted by the Worker. */
  deadline: number;
}

/** Recipient selection criteria; the owner still checks current authorization. */
export interface NotificationMessageQuery {
  directOnly: boolean;
  includeText: boolean;
}

export interface NotificationEligibleMessage {
  reference: NotificationMessageReference;
  trigger: "direct" | "all";
  senderLabel: string;
  roomLabel: string;
  /** Authorized source text; null when the recipient needs no message preview. */
  text: string | null;
}
