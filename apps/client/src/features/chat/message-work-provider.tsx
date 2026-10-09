import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MessageWorkContext } from "./message-work-context";
import { MessageWork } from "./message-work";
import { useUnfinishedWork } from "./unfinished-work-context";

export function MessageWorkProvider({ children }: { children: ReactNode }) {
  const [work] = useState(() => new MessageWork());
  const status = useSyncExternalStore(work.subscribe, work.status, () => null);
  useUnfinishedWork(status);
  useLayoutEffect(() => work.attach(), [work]);
  return <MessageWorkContext value={work}>{children}</MessageWorkContext>;
}
