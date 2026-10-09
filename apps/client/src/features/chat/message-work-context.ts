import { createContext, useContext, useSyncExternalStore } from "react";
import { emptyMessageWork, type MessageWork } from "./message-work";

export const MessageWorkContext = createContext<MessageWork | null>(null);
const noSubscription = () => () => {};
export function useMessageWork(id: string) {
  const work = useContext(MessageWorkContext);
  const state = useSyncExternalStore(
    work?.subscribe ?? noSubscription,
    () => work?.get(id) ?? emptyMessageWork,
    () => emptyMessageWork,
  );
  return { work, state };
}
