import { useState, type ReactNode } from "react";
import { MediaLightbox } from "./media-lightbox";
import { MediaViewerContext, type ViewerRequest } from "./viewer-context";

/**
 * One viewer per account lifetime, mounted above the routes: it survives
 * virtualization of the row it was opened from and closes with the account.
 */
export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ViewerRequest | null>(null);
  return (
    <MediaViewerContext value={setRequest}>
      {children}
      {request && (
        <MediaLightbox request={request} close={() => setRequest(null)} />
      )}
    </MediaViewerContext>
  );
}
