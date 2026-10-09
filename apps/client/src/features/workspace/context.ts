import { createContext, useContext } from "react";
import type { WorkspaceNavigation } from "./use-navigation";

export const WorkspaceContext = createContext<{
  navigation: WorkspaceNavigation;
  openNavigation(): void;
} | null>(null);

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace)
    throw new Error("Workspace pages require the workspace layout.");
  return workspace;
}
