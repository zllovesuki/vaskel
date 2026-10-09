import { Film, ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { ModalDialog } from "@/client/ui/dialog";
import { Unavailable } from "@/client/ui/failure";
import { Placeholder } from "@/client/ui/loading-skeleton";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { AttachmentDownloadLink } from "./download-link";
import {
  grantUsable,
  useAttachmentGrant,
  type AttachmentGrantState,
} from "./use-attachment-grant";
import type { ViewerRequest } from "./viewer-context";

/**
 * The full-viewport viewer opens at once with the filename, Download and
 * Close, and shows its media as soon as the grant query holds a URL that is
 * usable or was fetched since opening; a worn-out grant refetches on mount.
 * The media keeps that URL until Try again. A refused grant or an undecodable
 * load shows the unavailable state, and a download refresh that fails while
 * media is showing adds a notice without removing it.
 */
export function MediaLightbox({
  request,
  close,
}: {
  request: ViewerRequest;
  close: () => void;
}) {
  const online = useAccess().canUseNetwork;
  const { owner, file, kind } = request;
  const grant = useAttachmentGrant(owner, file, online);
  const [openedAt] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const candidate =
    grant.grant && (grantUsable(grant.grant) || grant.updatedAt >= openedAt)
      ? grant.grant.url
      : null;
  const refresh = () => void grant.fresh().catch(() => undefined);
  return (
    <ModalDialog
      layout="stage"
      title={file.filename}
      actions={
        <AttachmentDownloadLink
          file={file}
          grant={grant}
          className={buttonStyles({ variant: "stage", size: "icon" })}
        />
      }
      close={close}
    >
      <Stage
        key={attempt}
        kind={kind}
        name={file.filename}
        candidate={candidate}
        grant={grant}
        online={online}
        close={close}
        refresh={refresh}
        retry={() => {
          setAttempt((count) => count + 1);
          refresh();
        }}
      />
    </ModalDialog>
  );
}

/** One attempt: the first URL it sees is the one its media keeps. */
function Stage({
  kind,
  name,
  candidate,
  grant,
  online,
  close,
  refresh,
  retry,
}: {
  kind: "image" | "video";
  name: string;
  candidate: string | null;
  grant: AttachmentGrantState;
  online: boolean;
  close: () => void;
  refresh: () => void;
  retry: () => void;
}) {
  const { t } = useI18n();
  const [captured, setCaptured] = useState(candidate);
  // Adopt the first URL during render; later refreshes serve downloads only.
  if (captured === null && candidate !== null) setCaptured(candidate);
  const source = captured ?? candidate;
  const [failed, setFailed] = useState(false);
  // The one authored moment: the picture or clip settles into the stage once it
  // is really there, over the stage's own fade. Closing stays immediate.
  const [ready, setReady] = useState(false);
  const arrival = `transition-[opacity,scale] duration-300 ease-arrive ${ready ? "scale-100 opacity-100" : "scale-[0.96] opacity-0"}`;
  // Playback keys act at once, also when the clip appears after its grant arrived.
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    video.current?.focus();
  }, [source]);
  const blocked =
    failed || (source === null && !grant.fetching && (grant.failed || !online));
  return (
    <div
      className="relative flex size-full items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {blocked ? (
        <Notice
          message={t(
            kind === "video"
              ? "files.videoUnavailable"
              : "files.previewUnavailable",
          )}
          onRetry={retry}
          disabled={!online}
        />
      ) : source === null ? (
        <Placeholder
          label={t("chat.loading")}
          kind="media"
          className="grid place-items-center"
        >
          <span className="bone grid h-60 w-80 max-w-full place-items-center rounded-lg">
            {kind === "video" ? (
              <Film className="size-8 text-stage-muted" aria-hidden="true" />
            ) : (
              <ImageIcon
                className="size-8 text-stage-muted"
                aria-hidden="true"
              />
            )}
          </span>
        </Placeholder>
      ) : kind === "video" ? (
        <video
          ref={video}
          src={source}
          controls
          autoPlay
          playsInline
          aria-label={name}
          className={`max-h-full max-w-full ${arrival}`}
          onLoadedMetadata={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          src={source}
          alt={t("files.imagePreview", { name })}
          className={`max-h-full max-w-full object-contain ${arrival}`}
          decoding="async"
          draggable={false}
          onLoad={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      )}
      {!blocked && source !== null && grant.failed && !grant.fetching && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
          <Notice
            message={t("files.downloadUnavailable")}
            onRetry={refresh}
            disabled={!online}
          />
        </div>
      )}
    </div>
  );
}

function Notice({
  message,
  onRetry,
  disabled,
}: {
  message: string;
  onRetry: () => void;
  disabled: boolean;
}) {
  // A notice settles up into place like other dialog content.
  return (
    <div className="rounded-lg bg-surface px-4 py-3 text-ink shadow-popover transition-[opacity,translate] duration-200 ease-arrive starting:translate-y-1 starting:opacity-0">
      <Unavailable
        message={message}
        onRetry={onRetry}
        disabled={disabled}
        role="status"
      />
    </div>
  );
}
