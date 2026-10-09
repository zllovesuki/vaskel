import { ImageIcon, Play } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AttachmentDescriptor } from "@vaskel/contracts/attachments";
import { fileThumbnailPath } from "@vaskel/contracts/api";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Unavailable } from "@/client/ui/failure";
import { Placeholder } from "@/client/ui/loading-skeleton";
import { PreviewResource } from "./preview-resource";
import type { AttachmentGrantState } from "./use-attachment-grant";

type Phase = "loading" | "ready" | "unavailable";

/** A selected local file: its bytes are checked and shown without any network. */
export function SelectedImagePreview({ file }: { file: File }) {
  const [resource] = useState(() => new PreviewResource());
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getServerSnapshot,
  );
  useEffect(() => {
    void resource.load(file);
    return () => resource.dispose();
  }, [file, resource]);
  if (
    state.phase === "idle" ||
    state.phase === "loading" ||
    state.phase === "unsupported"
  )
    return null;
  const url = "url" in state ? state.url : undefined;
  return (
    <ImagePreviewFrame
      compact
      src={url}
      phase={
        state.phase === "ready"
          ? "ready"
          : state.phase === "decoding"
            ? "loading"
            : "unavailable"
      }
      name={file.name}
      onLoad={() => url && resource.decoded(url)}
      onError={() => url && resource.failed(url)}
    />
  );
}

/**
 * Granted images and generated video posters share a preview frame. A video
 * tile opens the viewer even when its optional poster cannot load.
 */
export function SentImagePreview({
  file,
  grant,
  online,
  open,
  kind = "image",
}: {
  file: AttachmentDescriptor;
  grant: AttachmentGrantState;
  online: boolean;
  open?: (() => void) | undefined;
  kind?: "image" | "video";
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="px-2 pt-2">
      <ImagePreviewFrame
        src={
          kind === "video" && grant.url
            ? fileThumbnailPath(grant.url)
            : grant.url
        }
        attempt={attempt}
        phase={grant.failed ? "unavailable" : grant.url ? phase : "loading"}
        name={file.filename}
        lazy
        onLoad={() => setPhase("ready")}
        onError={() => setPhase("unavailable")}
        onRetry={() => {
          if (grant.failed) {
            grant.retry();
            return;
          }
          void grant.fresh().then(
            () => {
              setPhase("loading");
              setAttempt((count) => count + 1);
            },
            () => undefined,
          );
        }}
        retryDisabled={!online}
        open={open}
        kind={kind}
      />
    </div>
  );
}

function ImagePreviewFrame({
  src,
  attempt = 0,
  phase,
  name,
  lazy = false,
  compact = false,
  onLoad,
  onError,
  onRetry,
  retryDisabled = false,
  open,
  kind = "image",
}: {
  src?: string | undefined;
  attempt?: number;
  phase: Phase;
  name: string;
  lazy?: boolean;
  compact?: boolean;
  onLoad?: () => void;
  onError?: () => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
  open?: (() => void) | undefined;
  kind?: "image" | "video";
}) {
  const { t } = useI18n();
  return (
    <div
      className={
        compact
          ? "relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-surface"
          : "relative mt-1 mb-2 grid aspect-[4/3] w-full max-w-80 place-items-center overflow-hidden rounded-md bg-subtle"
      }
      aria-busy={phase === "loading"}
    >
      {src !== undefined && phase !== "unavailable" && (
        <img
          key={attempt}
          src={src}
          alt={t("files.imagePreview", { name })}
          className={`absolute inset-0 size-full object-contain ${phase === "ready" ? "" : "invisible"}`}
          decoding="async"
          draggable={false}
          {...(lazy ? { loading: "lazy" } : {})}
          onLoad={onLoad}
          onError={onError}
        />
      )}
      {open && (phase === "ready" || kind === "video") && (
        <button
          type="button"
          className={`absolute inset-0 z-10 grid place-items-center rounded-md -outline-offset-2 ${kind === "video" ? "cursor-pointer" : "cursor-zoom-in"}`}
          aria-haspopup="dialog"
          aria-label={t(
            kind === "video" ? "files.playFile" : "files.previewFile",
            { name },
          )}
          onClick={open}
        >
          {kind === "video" && (
            <span className="grid size-10 place-items-center rounded-full bg-surface/90 shadow-sm">
              <Play className="size-5" aria-hidden="true" />
            </span>
          )}
        </button>
      )}
      {phase === "unavailable" ? (
        kind === "video" ? null : onRetry ? (
          <Unavailable
            message={t("files.previewUnavailable")}
            onRetry={onRetry}
            disabled={retryDisabled}
            role="status"
            className="px-3 text-center"
          />
        ) : (
          <span
            className={
              compact
                ? "px-1 text-center text-fine text-muted"
                : "px-3 text-center text-caption text-muted"
            }
            role="status"
          >
            {t("files.previewUnavailable")}
          </span>
        )
      ) : (
        phase === "loading" && (
          <Placeholder
            label={t("files.previewLoading")}
            kind="image"
            className="absolute inset-0"
          >
            <span className="bone grid size-full place-items-center">
              <ImageIcon className="size-6 text-muted" aria-hidden="true" />
            </span>
          </Placeholder>
        )
      )}
    </div>
  );
}
