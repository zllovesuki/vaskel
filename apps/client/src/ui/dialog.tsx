import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { buttonStyles } from "@vaskel/ui/components/control-styles";

/**
 * The modal `<dialog>`. It opens on mount, closes on Escape, on the close button
 * and on a click outside its box, and returns focus to the opener through the
 * native close behaviour, which needs the dialog still in the document: the
 * layout cleanup runs before React removes it. A caller with pending work
 * passes a `close` that keeps the dialog open. It renders into `document.body`
 * so that an opener inside a heading or a menu lends it no typography. The
 * `stage` layout fills the viewport with a dark stage under a header bar, and a
 * click on the empty stage dismisses it.
 */
export function ModalDialog({
  title,
  description,
  close,
  children,
  width = "default",
  layout = "panel",
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  close: () => void;
  children: ReactNode;
  width?: "default" | "wide";
  layout?: "panel" | "stage";
  /** Header controls before Close, such as the viewer's Download. */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const stage = layout === "stage";
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    // showModal moves focus to the first control; a form may name a better one,
    // and header actions never take it by DOM order alone.
    (
      element?.querySelector<HTMLElement>("[data-autofocus]") ??
      closeButton.current
    )?.focus();
    return () => element?.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      // A dialog keeps every key: the transcript's roving handler ignores this scope.
      data-focus-scope
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // The box settles up into place over a darkening page, the stage only
      // fades in; closing is immediate.
      className={
        stage
          ? "fixed inset-0 flex size-auto max-h-none max-w-none flex-col overflow-hidden bg-stage text-stage-ink transition-opacity duration-200 ease-arrive backdrop:bg-black/80 backdrop:transition-colors backdrop:duration-200 backdrop:ease-out starting:opacity-0 starting:backdrop:bg-black/0"
          : `m-auto max-h-[calc(100dvh-32px)] overflow-auto rounded-xl border border-line bg-surface p-5 text-ink shadow-popover transition-[opacity,translate,scale] duration-200 ease-arrive backdrop:bg-black/40 backdrop:transition-colors backdrop:duration-200 backdrop:ease-out starting:translate-y-2 starting:scale-[0.98] starting:opacity-0 starting:backdrop:bg-black/0 ${width === "wide" ? "w-[min(620px,calc(100vw-24px))]" : "w-[min(460px,calc(100vw-24px))]"}`
      }
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        // Portals bubble through React parents; Escape belongs to the dialog.
        if (event.key === "Escape") event.stopPropagation();
      }}
      onClick={(event) => {
        if (stage || event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          close();
      }}
    >
      <div
        className={
          stage
            ? "flex shrink-0 items-center gap-1 border-b border-stage-line py-1.5 pr-2 pl-4"
            : "mb-4 flex items-start justify-between gap-3"
        }
      >
        <div className={stage ? "min-w-0 flex-1" : "min-w-0"}>
          <h2
            id={titleId}
            className={
              stage
                ? "truncate text-ui font-medium"
                : "text-base font-semibold wrap-anywhere"
            }
          >
            {title}
          </h2>
          {description && (
            <p
              id={descriptionId}
              className="mt-1 text-caption leading-relaxed text-muted"
            >
              {description}
            </p>
          )}
        </div>
        {actions}
        <button
          ref={closeButton}
          type="button"
          className={buttonStyles(
            stage
              ? { variant: "stage", size: "icon" }
              : { variant: "quiet", size: "icon-small" },
          )}
          onClick={close}
          aria-label={t("common.close")}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {stage ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </dialog>,
    document.body,
  );
}

/** A button that opens a modal dialog; the content receives `close`. */
export function DialogButton({
  label,
  buttonClass = buttonStyles(),
  title,
  description,
  width,
  children,
}: {
  label: ReactNode;
  buttonClass?: string;
  title: ReactNode;
  description?: ReactNode;
  width?: "default" | "wide";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        className={buttonClass}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <ModalDialog
          title={title}
          description={description}
          close={close}
          {...(width ? { width } : {})}
        >
          {children(close)}
        </ModalDialog>
      )}
    </>
  );
}
