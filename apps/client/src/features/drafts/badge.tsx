import { useSyncExternalStore } from "react";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useDraftManager } from "./context";

export function DraftBadge({
  owner,
  channelId,
}: {
  owner: OwnerScope;
  channelId: string;
}) {
  const manager = useDraftManager();
  const hasDraft = useSyncExternalStore(manager.subscribe, () =>
    manager.hasDraft({ owner, channelId }),
  );
  const { t } = useI18n();
  return hasDraft ? (
    <span className="ml-auto shrink-0 text-fine font-normal text-muted">
      {t("drafts.badge")}
    </span>
  ) : null;
}
