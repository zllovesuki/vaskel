import { createContext, useContext } from "react";
import type { AttachmentDescriptor } from "@vaskel/contracts/attachments";
import type { OwnerScope } from "@vaskel/contracts/messaging";

export interface ViewerRequest {
  owner: OwnerScope;
  file: AttachmentDescriptor;
  kind: "image" | "video";
}

export const MediaViewerContext = createContext<
  ((request: ViewerRequest) => void) | null
>(null);

/** Absent where no viewer is mounted, such as the cached offline workspace; entry points then stay hidden. */
export const useMediaViewer = () => useContext(MediaViewerContext);
