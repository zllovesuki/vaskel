import { NavigationToggle } from "@vaskel/ui/components/home";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { chatHeaderStyles } from "@vaskel/ui/components/control-styles";
import {
  SettingsSection,
  settingsBodyStyles,
  settingsColumnStyles,
} from "@/client/ui/settings-section";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { LanguageSelector } from "./language-selector";
import { ProfileForm } from "./profile-form";
import { SecurityForm } from "./security-form";
import { SessionsPanel } from "./sessions-panel";
import { ThemeSelector } from "./theme-selector";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";

export function AccountSettings({
  onNavigation,
}: {
  onNavigation: () => void;
}) {
  const { t } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("account.title")}
    >
      <header className={chatHeaderStyles}>
        <NavigationToggle
          action="open"
          label={t("account.openNavigation")}
          onClick={onNavigation}
        />
        <Avatar name={user.displayName} hue={personHue(user.userId)} />
        <div className="mr-auto min-w-0">
          <h1 className="text-base font-semibold">{t("account.title")}</h1>
          <p className="truncate text-caption text-muted">{user.displayName}</p>
        </div>
      </header>
      <div className={settingsBodyStyles}>
        <div className={settingsColumnStyles}>
          {!canUseNetwork && (
            <p role="status" className="mt-5 text-caption text-muted">
              {t("account.offline")}
            </p>
          )}
          <SettingsSection
            title={t("account.profile")}
            description={t("account.profileDescription")}
          >
            <ProfileForm />
          </SettingsSection>
          <SettingsSection title={t("account.security")}>
            <SecurityForm />
          </SettingsSection>
          <SettingsSection
            title={t("account.sessions")}
            description={t("account.sessionsDescription")}
            width="full"
          >
            <SessionsPanel />
          </SettingsSection>
          <SettingsSection
            title={t("account.preferences")}
            description={t("account.languageDescription")}
          >
            <LanguageSelector />
            <ThemeSelector />
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
