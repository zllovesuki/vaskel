import { useI18n } from "@/client/features/i18n/use-i18n";
import { useQuery } from "@tanstack/react-query";
import type { BlockStatus } from "@vaskel/contracts/blocking";
import { blockPollInterval, blockStatusOptions } from "@/client/api/blocks";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useBlockSetting } from "@/client/features/blocking/use-block-setting";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { Unavailable } from "@/client/ui/failure";

export function PersonBlockControl({
  targetId,
  name,
}: {
  targetId: string;
  name: string;
}) {
  const { t } = useI18n();
  const user = useUser();
  const inbox = useAccountEvents();
  const { canUseNetwork } = useAccess();
  const query = useQuery({
    ...blockStatusOptions(
      user.userId,
      targetId,
      blockPollInterval(inbox.connected),
    ),
    enabled: canUseNetwork,
  });
  if (!query.data)
    return query.error ? (
      <Unavailable
        role="status"
        message={t("blocking.checkFailed")}
        onRetry={() => void query.refetch()}
        disabled={!canUseNetwork}
      />
    ) : (
      <p role="status" className="text-caption text-muted">
        {t("blocking.checking")}
      </p>
    );
  return <BlockControl status={query.data} name={name} />;
}

export function BlockControl({
  status,
  name,
}: {
  status: BlockStatus;
  name: string;
}) {
  const setting = useBlockSetting(status, name);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        className={buttonStyles({
          variant: setting.blocked ? "default" : "quiet",
          size: "small",
        })}
        disabled={setting.disabled}
        aria-label={setting.accessibleName}
        onClick={setting.commit}
      >
        {setting.label}
      </button>
      {setting.error && (
        <p role="alert" className="max-w-prose text-caption text-error">
          {setting.error}
        </p>
      )}
    </div>
  );
}
