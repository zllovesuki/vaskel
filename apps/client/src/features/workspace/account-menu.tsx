import { cleanupNotificationsOnLogout } from "@/client/features/notifications/browser";
import { LanguageSelector } from "@/client/features/account/language-selector";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  formStyles,
  menuItemStyles,
} from "@vaskel/ui/components/control-styles";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { signOut, useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { Popover } from "@/client/ui/popover";
import { Failure } from "@/client/ui/failure";
import { ThemeMenuItem } from "@/client/features/account/theme-toggle";
import { useMediaController } from "@/client/features/media/context";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";

export function AccountMenu({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useI18n();
  const user = useUser();
  const access = useAccess();
  const media = useMediaController();
  const logout = useMutation({
    mutationFn: async () => {
      const accountId = user.userId;
      cleanupNotificationsOnLogout(accountId);
      // Close private state and commit local invalidation before slow cleanup.
      await access.logout();
      try {
        await media.leave();
        await signOut(accountId);
      } catch (error) {
        access.signOutFailed(error);
        throw error;
      }
    },
  });

  return (
    <Popover
      label={
        <>
          <Avatar
            name={user.displayName}
            hue={personHue(user.userId)}
            size={8}
          />
          <span className="sr-only">{t("workspace.accountOptions")}</span>
        </>
      }
      buttonClass={buttonStyles({
        variant: "quiet",
        size: "icon",
        shape: "round",
      })}
    >
      {(close) => (
        <div className={formStyles}>
          <div className="flex items-center gap-2.5">
            <Avatar name={user.displayName} hue={personHue(user.userId)} />
            <div className="min-w-0 flex-1 leading-snug">
              <h2 className="truncate text-ui">{user.displayName}</h2>
              <span className="text-fine text-muted">
                {user.isOperator
                  ? t("workspace.operator")
                  : t("workspace.account")}
              </span>
            </div>
          </div>
          <LanguageSelector compact />
          <div className="flex flex-col gap-0.5">
            <ThemeMenuItem />
            <Link
              to="/settings/account"
              search={{}}
              className={`${menuItemStyles} no-underline`}
              onClick={() => {
                close();
                onNavigate();
              }}
            >
              {t("workspace.accountSettings")}
            </Link>
            <Link
              to="/settings/notifications"
              search={{}}
              className={`${menuItemStyles} no-underline`}
              onClick={() => {
                close();
                onNavigate();
              }}
            >
              {t("notifications.title")}
            </Link>
            <Link
              to="/settings/blocked"
              search={{}}
              className={`${menuItemStyles} no-underline`}
              onClick={() => {
                close();
                onNavigate();
              }}
            >
              {t("workspace.blockedPeople")}
            </Link>
            {user.isOperator && (
              <Link
                to="/settings/host"
                search={{}}
                className={`${menuItemStyles} no-underline`}
                onClick={() => {
                  close();
                  onNavigate();
                }}
              >
                <span className="flex min-w-0 flex-col leading-snug">
                  <span>{t("workspace.yourVaskel")}</span>
                  <span className="text-fine text-muted">
                    {t("workspace.hostSettings")}
                  </span>
                </span>
              </Link>
            )}
          </div>
          <p className="text-caption text-muted wrap-anywhere">{user.email}</p>
          <button
            className={buttonStyles()}
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            {logout.isPending
              ? t("workspace.signingOut")
              : t("workspace.signOut")}
          </button>
          <Failure error={logout.error} />
        </div>
      )}
    </Popover>
  );
}
