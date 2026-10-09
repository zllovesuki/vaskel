import { Download } from "lucide-react";
import type { AttachmentDescriptor } from "@vaskel/contracts/attachments";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { grantUsable, type AttachmentGrantState } from "./use-attachment-grant";

/** Downloads through a usable grant natively; a missing or worn-out one is refreshed first. */
export function AttachmentDownloadLink({
  file,
  grant,
  className,
}: {
  file: AttachmentDescriptor;
  grant: AttachmentGrantState;
  className: string;
}) {
  const { t } = useI18n();
  const label = t("files.downloadFile", { name: file.filename });
  return (
    <a
      className={className}
      href={grant.url ?? "#"}
      download={file.filename}
      aria-label={label}
      title={label}
      onClick={(event) => {
        if (grant.grant && grantUsable(grant.grant)) return;
        event.preventDefault();
        void grant.fresh().then(
          (url) => {
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = file.filename;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
          },
          // A refused refresh is reported through the query state, in the row or the viewer.
          () => undefined,
        );
      }}
    >
      <Download aria-hidden="true" />
      <span className="sr-only">{t("files.download")}</span>
    </a>
  );
}
