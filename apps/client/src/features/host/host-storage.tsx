import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Bone,
  Line,
  PendingLabel,
  Placeholder,
} from "@/client/ui/loading-skeleton";
import { operatorUsageOptions } from "@/client/api/instance";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";
import { Unavailable } from "@/client/ui/failure";
import { usageIncomplete, usagePercent } from "./host-model";

/** The numbers carry the meaning; the bar is a thin restatement of them. */
function UsageBar({
  label,
  usedBytes,
  budgetBytes,
  full,
}: {
  label: string;
  usedBytes: number;
  budgetBytes: number;
  full?: boolean;
}) {
  const { t, formatFileSize } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-caption">
        <span className="font-medium">{label}</span>
        <span className="text-muted tabular-nums">
          {t("host.storageAmount", {
            used: formatFileSize(usedBytes),
            budget: formatFileSize(budgetBytes),
          })}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-subtle"
        aria-hidden="true"
      >
        <div
          className={`h-full rounded-full ${full ? "bg-error" : "bg-muted"}`}
          style={{ width: `${usagePercent(usedBytes, budgetBytes)}%` }}
        />
      </div>
    </div>
  );
}

/** What each circle and conversation on this vaskel. is using. */
export function HostStorage() {
  const { t } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const usage = useInfiniteQuery({
    ...operatorUsageOptions(user.userId),
    enabled: canUseNetwork,
  });
  const pages = usage.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.owners);
  const incomplete = pages.some(usageIncomplete);
  return (
    <div className="flex flex-col gap-4">
      {usage.isPending && canUseNetwork && (
        <Placeholder
          label={t("workspace.loading")}
          kind="storage"
          className="flex flex-col gap-5"
        >
          {[0, 1].map((index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Line width="w-14" />
                <Line size="fine" width="w-16" />
              </div>
              {[t("host.storageMessages"), t("host.storageFiles")].map(
                (label) => (
                  <div key={label} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-caption">
                      <span className="font-medium">{label}</span>
                      <Line size="caption" width="w-28" />
                    </div>
                    <Bone className="h-1.5 rounded-full" />
                  </div>
                ),
              )}
            </div>
          ))}
        </Placeholder>
      )}
      {usage.error && (
        <Unavailable
          message={t("host.storageUnavailable")}
          onRetry={() => void usage.refetch()}
          disabled={!canUseNetwork}
        />
      )}
      {incomplete && (
        <p role="status" className={noticeStyles()}>
          {t("host.storagePartial")}
        </p>
      )}
      {usage.isSuccess && rows.length === 0 && (
        <p className="text-caption text-muted">{t("host.storageEmpty")}</p>
      )}
      <ul className="flex flex-col gap-5">
        {rows.map(({ owner, sql, attachments }) => (
          <li key={`${owner.kind}:${owner.id}`} className="flex flex-col gap-2">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ui font-medium">
                {owner.kind === "server"
                  ? t("host.ownerCircle")
                  : t("host.ownerConversation")}
              </span>
              <span className="font-mono text-fine text-muted" title={owner.id}>
                {owner.id.slice(0, 8)}
              </span>
              {sql.status !== "normal" && (
                <span
                  className={`rounded-full px-2 py-0.5 text-fine font-semibold ${
                    sql.status === "paused"
                      ? "bg-error-soft text-error"
                      : "bg-subtle text-muted"
                  }`}
                >
                  {sql.status === "paused"
                    ? t("host.storagePaused")
                    : t("host.storageWarning")}
                </span>
              )}
            </p>
            <UsageBar
              label={t("host.storageMessages")}
              usedBytes={sql.usedBytes}
              budgetBytes={sql.budgetBytes}
              full={sql.status === "paused"}
            />
            <UsageBar
              label={t("host.storageFiles")}
              usedBytes={attachments.chargedBytes}
              budgetBytes={attachments.budgetBytes}
            />
          </li>
        ))}
      </ul>
      {usage.hasNextPage && (
        <div>
          <button
            className={buttonStyles({ size: "small" })}
            disabled={!canUseNetwork || usage.isFetchingNextPage}
            aria-busy={usage.isFetchingNextPage}
            onClick={() => void usage.fetchNextPage()}
          >
            <PendingLabel
              pending={usage.isFetchingNextPage}
              label={t("workspace.loading")}
            >
              {t("host.loadMore")}
            </PendingLabel>
          </button>
        </div>
      )}
    </div>
  );
}
