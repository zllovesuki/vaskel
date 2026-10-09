import { useInfiniteQuery } from "@tanstack/react-query";
import { PendingLabel, PeopleSkeleton } from "@/client/ui/loading-skeleton";
import { BadgeCheck } from "lucide-react";
import { operatorAccountsOptions } from "@/client/api/instance";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { Unavailable } from "@/client/ui/failure";
import { isInstant, UNKNOWN_DATE } from "./host-model";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";

/** Every account on this vaskel., one bounded page at a time. */
export function HostPeople() {
  const { t, formatDate, formatNumber } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const accounts = useInfiniteQuery({
    ...operatorAccountsOptions(user.userId),
    enabled: canUseNetwork,
  });
  const rows = accounts.data?.pages.flatMap((page) => page.accounts) ?? [];
  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 && (
        <p className="text-caption text-muted">
          {accounts.hasNextPage
            ? t("host.accountsMore", {
                count: formatNumber(rows.length),
                total: rows.length,
              })
            : t("host.accountsCount", {
                count: formatNumber(rows.length),
                total: rows.length,
              })}
        </p>
      )}
      {accounts.isPending && canUseNetwork && (
        <PeopleSkeleton label={t("workspace.loadingPeople")} />
      )}
      {accounts.error && (
        <Unavailable
          message={t("host.peopleUnavailable")}
          onRetry={() => void accounts.refetch()}
          disabled={!canUseNetwork}
        />
      )}
      <ul className="flex flex-col gap-1">
        {rows.map((account) => (
          <li key={account.id} className="flex items-center gap-3 py-1.5">
            <Avatar name={account.displayName} hue={personHue(account.id)} />
            <span className="min-w-0 flex-1 leading-snug">
              <span className="flex items-center gap-1.5 text-ui font-medium">
                <span className="truncate">{account.displayName}</span>
                {account.verified && (
                  <BadgeCheck
                    className="size-3.5 shrink-0 text-muted"
                    aria-hidden="true"
                  />
                )}
              </span>
              <span className="block text-caption text-muted">
                {account.verified ? t("host.verified") : t("host.unverified")}
                {" · "}
                {t("host.joined", {
                  date: isInstant(account.createdAt)
                    ? formatDate(account.createdAt)
                    : UNKNOWN_DATE,
                })}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {accounts.hasNextPage && (
        <div>
          <button
            className={buttonStyles({ size: "small" })}
            disabled={!canUseNetwork || accounts.isFetchingNextPage}
            aria-busy={accounts.isFetchingNextPage}
            onClick={() => void accounts.fetchNextPage()}
          >
            <PendingLabel
              pending={accounts.isFetchingNextPage}
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
