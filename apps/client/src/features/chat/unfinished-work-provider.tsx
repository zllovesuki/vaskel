import { useBlocker } from "@tanstack/react-router";
import {
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { UnfinishedWorkContext } from "@/client/features/chat/unfinished-work-context";
import {
  UnfinishedWorkGuard,
  type UnfinishedWorkState,
} from "@/client/features/chat/unfinished-work";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonRowStyles,
  buttonStyles,
} from "@vaskel/ui/components/control-styles";
import { ModalDialog } from "@/client/ui/dialog";

/** Mount inside the existing account key, above the changing route outlet. */
export function UnfinishedWorkProvider({ children }: { children: ReactNode }) {
  const [guard] = useState(() => new UnfinishedWorkGuard());
  const confirmation = useSyncExternalStore(guard.subscribe, guard.getSnapshot);
  const shouldBlockFn = useCallback(
    ({
      current,
      next,
    }: {
      current: { pathname: string };
      next: { pathname: string };
    }) => guard.blockNavigation(current.pathname, next.pathname),
    [guard],
  );
  useBlocker({ shouldBlockFn, enableBeforeUnload: guard.hasWork });
  useLayoutEffect(() => () => guard.retire(), [guard]);

  return (
    <UnfinishedWorkContext value={guard}>
      {children}
      {confirmation && (
        <UnfinishedWorkDialog
          confirmation={confirmation}
          keep={guard.keep}
          abandon={guard.abandon}
        />
      )}
    </UnfinishedWorkContext>
  );
}

function UnfinishedWorkDialog({
  confirmation,
  keep,
  abandon,
}: {
  confirmation: Exclude<UnfinishedWorkState, null>;
  keep: () => void;
  abandon: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalDialog
      title={t("chat.unfinishedTitle")}
      description={t(
        confirmation === "uncertain"
          ? "chat.unfinishedUncertain"
          : confirmation === "sending"
            ? "chat.unfinishedSending"
            : "chat.unfinishedDescription",
      )}
      // Escape, the close control and a click outside all keep the work.
      close={keep}
    >
      <div className={`${buttonRowStyles} justify-end`}>
        <button
          className={buttonStyles({ variant: "quiet" })}
          onClick={abandon}
        >
          {t(
            confirmation === "sending" || confirmation === "uncertain"
              ? "chat.leaveAnyway"
              : "chat.discardAndLeave",
          )}
        </button>
        <button
          className={buttonStyles({ variant: "primary" })}
          data-autofocus
          onClick={keep}
        >
          {t("chat.keepEditing")}
        </button>
      </div>
    </ModalDialog>
  );
}
