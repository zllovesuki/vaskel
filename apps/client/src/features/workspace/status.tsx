import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { reloadToUpdate } from "@/client/shell/register";
import { useShellUpdate } from "@/client/shell/use-shell-update";
import { textButtonStyles } from "@vaskel/ui/components/control-styles";
import { StatusStrip } from "@/client/ui/status-strip";

export function WorkspaceStatus() {
  const { t, text } = useI18n();
  const access = useAccess();
  const updateAvailable = useShellUpdate();
  function chooseNotice() {
    if (access.view.kind !== "account") return null;
    const connection = access.view.connection;
    switch (connection.kind) {
      case "checking":
        return { message: t("workspace.checkingAccess"), action: null };
      case "unavailable":
        return {
          message: connection.error
            ? text(connection.error)
            : t("workspace.connectionLost"),
          action: {
            label: t("workspace.reconnect"),
            run: () => void access.retry(),
          },
        };
      case "ready":
        return updateAvailable
          ? {
              message: t("workspace.updateAvailable"),
              action: {
                label: t("workspace.reloadToUpdate"),
                run: () => void reloadToUpdate(),
              },
            }
          : null;
    }
  }
  const notice = chooseNotice();

  if (!notice) return null;
  return (
    <StatusStrip
      action={
        notice.action && (
          <button
            className={textButtonStyles({ size: "small" })}
            onClick={notice.action.run}
          >
            {notice.action.label}
          </button>
        )
      }
    >
      {notice.message}
    </StatusStrip>
  );
}
