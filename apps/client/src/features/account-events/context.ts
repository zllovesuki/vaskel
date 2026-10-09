import { createContext, useContext } from "react";
import type { AccountEventFrame } from "@vaskel/contracts/account-events";
import type { AccountEventsStatus } from "./connection";
import type { MediaRoomRef } from "@vaskel/contracts/media";
import type { OwnerScope } from "@vaskel/contracts/messaging";

export type CallListener = (room?: MediaRoomRef) => Promise<void>;
/** Called once an owner's changed content has retired its durable history. */
export type ContentListener = (owner: OwnerScope) => void;
export type ActivityListener = (
  notice: Extract<AccountEventFrame, { type: "activity" }>,
) => void;

export interface AccountEventsState {
  status: AccountEventsStatus;
  /** True while notices arrive live, which lets the pollers slow down. */
  connected: boolean;
  subscribeCalls(listener: CallListener): () => void;
  /** Mounted timelines reconcile through replay on their owner's content hints. */
  subscribeContent(listener: ContentListener): () => void;
  /** Fresh arrivals only; reconnects and replay never produce them. */
  subscribeActivity(listener: ActivityListener): () => void;
}
export const AccountEventsContext = createContext<AccountEventsState>({
  status: "offline",
  connected: false,
  subscribeCalls: () => () => {},
  subscribeContent: () => () => {},
  subscribeActivity: () => () => {},
});
export const useAccountEvents = () => useContext(AccountEventsContext);
