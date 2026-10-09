import type { ReactNode } from "react";
import { UnfinishedWorkProvider } from "@/client/features/chat/unfinished-work-provider";
import { DraftProvider } from "@/client/features/drafts/provider";
import { MediaViewerProvider } from "@/client/features/files/viewer-provider";
import MediaProvider from "@/client/features/media/provider";
import { MessageSoundCues } from "@/client/features/notifications/message-sound-cues";

/** Account resources load together after identity has been established. */
export default function AuthenticatedProviders({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <MediaProvider>
      <DraftProvider>
        <UnfinishedWorkProvider>
          <MediaViewerProvider>{children}</MediaViewerProvider>
        </UnfinishedWorkProvider>
      </DraftProvider>
      <MessageSoundCues />
    </MediaProvider>
  );
}
