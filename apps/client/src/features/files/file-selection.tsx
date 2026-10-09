import { SelectedImagePreview } from "./image-preview";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import type {
  SelectedFile,
  UploadController,
} from "@/client/features/files/upload-controller";

export function FileSelection({
  files,
  controller,
  disabled,
  uploadAllowed = true,
  previewAllowed = true,
}: {
  files: SelectedFile[];
  controller: UploadController;
  disabled: boolean;
  uploadAllowed?: boolean;
  previewAllowed?: boolean;
}) {
  const { t, text, formatFileSize } = useI18n();

  if (!files.length) return null;
  return (
    <ul
      aria-label={t("files.filesToSend")}
      className="flex max-h-52 flex-col gap-1 overflow-auto border-b border-line px-2 py-2"
    >
      {files.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-center gap-x-3 rounded-lg bg-subtle px-2.5 py-1.5"
        >
          {previewAllowed && <SelectedImagePreview file={item.file} />}
          <div className="min-w-0 flex-1 basis-32">
            <p className="text-caption font-medium wrap-anywhere">
              {item.file.name}
            </p>
            <p className="text-fine text-muted" role="status">
              {formatFileSize(item.file.size)} ·{" "}
              {item.phase === "ready"
                ? t("files.ready")
                : item.phase === "uploading"
                  ? t("files.uploading")
                  : item.phase === "checking"
                    ? t("files.checkingUpload")
                    : t("files.uploadNotReady")}
            </p>
            {item.error && (
              <p className="text-caption text-error" role="alert">
                {text(item.error)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {item.phase === "error" && (
              <>
                {item.fileId && (
                  <button
                    type="button"
                    className={buttonStyles({
                      variant: "quiet",
                      size: "small",
                    })}
                    disabled={disabled}
                    onClick={() => controller.check(item.id)}
                    aria-label={t("files.checkUpload", {
                      name: item.file.name,
                    })}
                  >
                    {t("files.checkStatus")}
                  </button>
                )}
                <button
                  type="button"
                  className={buttonStyles({ variant: "quiet", size: "small" })}
                  disabled={disabled || !uploadAllowed}
                  onClick={() => void controller.retry(item.id)}
                  aria-label={t("files.uploadFileAgain", {
                    name: item.file.name,
                  })}
                >
                  {t("files.uploadAgain")}
                </button>
              </>
            )}
            <button
              type="button"
              className={buttonStyles({ variant: "quiet", size: "small" })}
              disabled={disabled}
              onClick={() => controller.remove(item.id)}
              aria-label={
                item.phase === "uploading" || item.phase === "checking"
                  ? t("files.cancelUpload", { name: item.file.name })
                  : t("files.removeFile", { name: item.file.name })
              }
            >
              {item.phase === "uploading" || item.phase === "checking"
                ? t("files.cancel")
                : t("files.remove")}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
