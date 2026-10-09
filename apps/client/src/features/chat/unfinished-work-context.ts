import { createContext, useContext, useLayoutEffect, useRef } from "react";
import {
  UnfinishedWorkGuard,
  type UnfinishedWorkRegistration,
  type UnfinishedWorkState,
} from "@/client/features/chat/unfinished-work";

export const UnfinishedWorkContext = createContext<UnfinishedWorkGuard | null>(
  null,
);

/** Only status crosses into the navigation guard; message edits own their content. */
export function useUnfinishedWork(state: UnfinishedWorkState) {
  const guard = useContext(UnfinishedWorkContext);
  if (!guard) throw new Error("The unfinished-work provider is required.");
  const registration = useRef<UnfinishedWorkRegistration | null>(null);
  useLayoutEffect(() => {
    const current = guard.register();
    registration.current = current;
    return () => {
      registration.current = null;
      current.release();
    };
  }, [guard]);
  useLayoutEffect(() => {
    registration.current?.update(state);
  }, [guard, state]);
}
