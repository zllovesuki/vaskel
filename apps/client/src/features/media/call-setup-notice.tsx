import { useUser } from "@/client/features/auth/session-state";
import { useI18n } from "@/client/features/i18n/use-i18n";

/** A disabled Join points here, so every surface names the reason once. */
export const CALL_SETUP_NOTICE_ID = "call-setup-notice";

/**
 * Why calls cannot start on this vaskel. The host is the only account that can
 * supply the Realtime application, so the host also reads where it is
 * configured; everyone else reads the state alone.
 */
export function CallSetupNotice({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const user = useUser();
  return (
    <div id={CALL_SETUP_NOTICE_ID} className={className}>
      <p>{t("media.notConfigured")}</p>
      {user.isOperator && (
        <p className="mt-1">{t("media.notConfiguredHost")}</p>
      )}
    </div>
  );
}
