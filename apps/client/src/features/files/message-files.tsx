import { Paperclip, Trash } from "lucide-react";
import { ActionsMenu, type ActionsMenuItem } from "@/client/ui/actions-menu";
import { Unavailable } from "@/client/ui/failure";
import { AttachmentDownloadLink } from "./download-link";
import { SentImagePreview } from "./image-preview";
import { automaticImagePreview, automaticVideoPlayback } from "./raster-image";
import { useAttachmentGrant } from "./use-attachment-grant";
import { useMediaViewer } from "./viewer-context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import type { AttachmentDescriptor } from "@vaskel/contracts/attachments";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { buttonStyles } from "@vaskel/ui/components/control-styles";

type FileActions = {
  owner: OwnerScope;
  online: boolean;
  onRemove?: (fileId: string) => void;
  removalDisabled?: boolean;
};

export function MessageFiles({
  attachments,
  ...actions
}: FileActions & {
  attachments: AttachmentDescriptor[];
}) {
  const { t } = useI18n();
  if (!attachments.length) return null;
  return (
    <ul
      aria-label={t("files.attachments")}
      className="mt-2 flex max-w-[65ch] flex-col gap-1.5"
    >
      {attachments.map((file) => (
        <MessageFile key={file.fileId} file={file} {...actions} />
      ))}
    </ul>
  );
}

function MessageFile({
  file,
  owner,
  online,
  onRemove,
  removalDisabled = false,
}: FileActions & {
  file: AttachmentDescriptor;
}) {
  const { t, formatFileSize } = useI18n();
  const previewKind = automaticImagePreview(file.filename)
    ? "image"
    : automaticVideoPlayback(file.filename)
      ? "video"
      : null;
  const grant = useAttachmentGrant(owner, file, online);
  // The viewer opens at once and waits for its grant itself.
  const open = useMediaViewer();
  const menuItems: ActionsMenuItem[] = onRemove
    ? [
        {
          id: "remove",
          label: t("chat.removeAttachment"),
          icon: <Trash aria-hidden="true" />,
          disabled: removalDisabled,
          destructive: true,
          onSelect: () => onRemove(file.fileId),
        },
      ]
    : [];
  return (
    <li className="w-fit max-w-full overflow-hidden rounded-lg border border-line bg-surface">
      {online && previewKind && (
        <SentImagePreview
          file={file}
          grant={grant}
          online={online}
          kind={previewKind}
          open={
            open ? () => open({ owner, file, kind: previewKind }) : undefined
          }
        />
      )}
      {/* One row: the name gives way before the size and the actions do. */}
      <div className="flex items-center gap-x-2 py-1 pr-1 pl-3">
        <Paperclip className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1 py-1">
          <p className="flex min-w-0 items-baseline gap-x-2">
            <span
              className="truncate text-ui font-medium"
              title={file.filename}
            >
              {file.filename}
            </span>
            <span className="shrink-0 text-fine text-muted">
              {formatFileSize(file.byteLength)}
            </span>
          </p>
          {online && previewKind !== "image" && grant.failed && (
            <Unavailable
              message={t("files.downloadUnavailable")}
              onRetry={grant.retry}
              disabled={!online}
              role="status"
              className="mt-1"
            />
          )}
        </div>
        {online ? (
          <AttachmentDownloadLink
            file={file}
            grant={grant}
            className={buttonStyles({ variant: "quiet", size: "icon" })}
          />
        ) : (
          <span className="py-2 pr-2 text-caption text-muted">
            {t("files.reconnectToDownload")}
          </span>
        )}
        {online && menuItems.length > 0 && (
          <ActionsMenu
            label={t("files.actionsFor", { name: file.filename })}
            items={menuItems}
            buttonClass={buttonStyles({ variant: "quiet", size: "icon" })}
          />
        )}
      </div>
    </li>
  );
}
