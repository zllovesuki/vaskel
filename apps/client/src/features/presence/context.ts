import { createContext, useContext } from "react";
import type { PresenceOwner } from "./owner";

export const PresenceContext = createContext<PresenceOwner | null>(null);
/** Layouts declare rendered, unhidden panes; presence does not observe the viewport. */
export const PresenceVisibleContext = createContext(true);
export const usePresenceOwner = () => useContext(PresenceContext);
