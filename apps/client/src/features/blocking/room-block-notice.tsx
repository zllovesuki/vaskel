import { useI18n } from "@/client/features/i18n/use-i18n";
import { useQuery } from "@tanstack/react-query";
import type { MediaSnapshot } from "@vaskel/contracts/media";
import { blockPollInterval, roomBlockOptions } from "@/client/api/blocks";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useMedia } from "@/client/features/media/context";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { Unavailable } from "@/client/ui/failure";

export function RoomBlockNotice({
  snapshot,
  active = false,
}: {
  snapshot: MediaSnapshot;
  active?: boolean;
}) {
  const { t } = useI18n();
  const user = useUser();
  const inbox = useAccountEvents();
  const { canUseNetwork } = useAccess();
  const { controller, state } = useMedia();
  const ids = snapshot.participants
    .filter((person) => person.status === "active")
    .map((person) => person.userId);
  const query = useQuery({
    ...roomBlockOptions(user.userId, ids, blockPollInterval(inbox.connected)),
    enabled: canUseNetwork && ids.some((id) => id !== user.userId),
  });
  const blocked = query.data?.statuses.filter((status) => status.blocked) ?? [];
  // Keep the restore control available if someone is unblocked during this call.
  const visibleIds = new Set(ids);
  const affected = [
    ...new Set([
      ...blocked.map((status) => status.targetId),
      ...(active ? state.hiddenUserIds.filter((id) => visibleIds.has(id)) : []),
    ]),
  ];
  const { names } = useDisplayNames(affected);
  if (!affected.length && !query.error && !query.data?.partial) return null;
  return (
    <aside
      className="max-h-[30dvh] overflow-y-auto border-b border-line bg-subtle px-page-gutter py-3 text-ui"
      aria-label={t("blocking.participants")}
    >
      {blocked.length > 0 && (
        <p role="status">{t("blocking.roomDescription")}</p>
      )}
      {(query.error || query.data?.partial) && (
        <Unavailable
          role="status"
          message={t("blocking.roomPartial")}
          onRetry={() => void query.refetch()}
          disabled={!canUseNetwork}
        />
      )}
      {affected.map((id) => {
        const hidden = state.hiddenUserIds.includes(id);
        const name = names.get(id) ?? id;
        return (
          <div
            key={id}
            className="mt-2 flex flex-wrap items-center justify-between gap-2"
          >
            <span className="min-w-0 wrap-anywhere">
              {hidden && active
                ? t("blocking.hiddenPerson", { name })
                : t("blocking.blockedPerson", { name })}
            </span>
            {active ? (
              <button
                className={buttonStyles({ size: "small" })}
                disabled={!canUseNetwork}
                aria-label={
                  hidden
                    ? t("blocking.showNamedMedia", { name })
                    : t("blocking.hideNamedMedia", { name })
                }
                onClick={() => controller.setMediaHidden(id, !hidden)}
              >
                {hidden ? t("blocking.showMedia") : t("blocking.hideMedia")}
              </button>
            ) : null}
          </div>
        );
      })}
      {!active && blocked.length > 0 && (
        <p className="mt-2 text-caption text-muted">{t("blocking.roomHint")}</p>
      )}
    </aside>
  );
}
