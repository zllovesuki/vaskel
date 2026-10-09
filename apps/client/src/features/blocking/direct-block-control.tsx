import { Ellipsis } from "lucide-react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useQuery } from "@tanstack/react-query";
import { blockPollInterval, directBlockOptions } from "@/client/api/blocks";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { BlockControl } from "@/client/features/blocking/block-control";
import { Popover } from "@/client/ui/popover";
import { buttonStyles, formStyles } from "@vaskel/ui/components/control-styles";
import { Unavailable } from "@/client/ui/failure";

export function DirectBlockControl({
  conversationId,
  name,
}: {
  conversationId: string;
  name: string;
}) {
  const { t } = useI18n();
  const user = useUser();
  const inbox = useAccountEvents();
  const { canUseNetwork } = useAccess();
  const query = useQuery({
    ...directBlockOptions(
      user.userId,
      conversationId,
      blockPollInterval(inbox.connected),
    ),
    enabled: canUseNetwork,
  });
  return (
    <Popover
      label={
        <>
          <Ellipsis className="size-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">
            {t("blocking.options")}
          </span>
        </>
      }
      buttonClass={buttonStyles({
        variant: "quiet",
        size: "small",
        className: "max-sm:px-2",
      })}
    >
      {() => (
        <div className={formStyles}>
          <h2 className="wrap-anywhere">{name}</h2>
          <p className="text-ui text-muted">
            {t("blocking.directDescription")}
          </p>
          {query.data ? (
            <>
              <p role="status" className="text-ui">
                {query.data.blocked
                  ? t("blocking.youBlocked")
                  : query.data.canSend
                    ? t("blocking.allowed")
                    : t("blocking.blocked")}
              </p>
              <BlockControl
                key={query.data.targetId}
                status={query.data}
                name={name}
              />
            </>
          ) : !query.error ? (
            <p role="status" className="text-ui text-muted">
              {t("blocking.checking")}
            </p>
          ) : null}
          {query.error && (
            <Unavailable
              role="status"
              message={t("blocking.latestFailed")}
              onRetry={() => void query.refetch()}
              disabled={!canUseNetwork}
            />
          )}
        </div>
      )}
    </Popover>
  );
}
