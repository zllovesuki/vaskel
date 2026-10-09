import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { RebuildSearchIndexesSummary } from "@vaskel/contracts/search";
import {
  buttonStyles,
  fieldHintStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";
import { rebuildSearchIndexes } from "@/client/api/search-index";
import { hostKey } from "@/client/api/instance";
import { errorMessage, isCancellation } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { settingsRowStyles } from "@/client/ui/settings-section";
import { PendingLabel } from "@/client/ui/loading-skeleton";

export function HostSearchIndex() {
  const { t, text, formatNumber } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const hint = useId();
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<Omit<
    RebuildSearchIndexesSummary,
    "type"
  > | null>(null);
  const rebuild = useMutation({
    mutationKey: [...hostKey(user.userId), "rebuild-search-index"],
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      const active = new AbortController();
      controller.current = active;
      setProgress(null);
      try {
        return await rebuildSearchIndexes(setProgress, active.signal);
      } finally {
        if (controller.current === active) controller.current = null;
      }
    },
  });
  useEffect(() => () => controller.current?.abort(), [user.userId]);
  useEffect(() => {
    if (!canUseNetwork) controller.current?.abort();
  }, [canUseNetwork]);
  const result = rebuild.data;
  return (
    <div>
      <div className={settingsRowStyles}>
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-ui font-medium">{t("host.searchIndexes")}</h3>
          <p id={hint} className={`${fieldHintStyles} mt-1`}>
            {t("host.searchIndexesHint")}
          </p>
        </div>
        <button
          type="button"
          className={buttonStyles()}
          aria-describedby={hint}
          disabled={!canUseNetwork || rebuild.isPending}
          onClick={() => rebuild.mutate()}
        >
          <PendingLabel
            pending={rebuild.isPending}
            label={t("host.rebuildingIndexes")}
          >
            {t("host.rebuildIndexes")}
          </PendingLabel>
        </button>
      </div>
      <p role="status" className="text-caption text-muted tabular-nums">
        {rebuild.isPending
          ? t("host.rebuildProgress", {
              count: formatNumber(progress?.rebuilt ?? 0),
            })
          : result
            ? result.failed > 0
              ? t("host.rebuildPartial", {
                  rebuilt: formatNumber(result.rebuilt),
                  failed: formatNumber(result.failed),
                })
              : t("host.rebuildComplete", {
                  count: formatNumber(result.rebuilt),
                  total: result.rebuilt,
                })
            : null}
      </p>
      {rebuild.isError && (
        <div role="alert" className={noticeStyles({ error: true })}>
          <p>
            {t("host.rebuildInterrupted", {
              count: formatNumber(progress?.rebuilt ?? 0),
            })}
          </p>
          {!isCancellation(rebuild.error) && (
            <p>{text(errorMessage(rebuild.error))}</p>
          )}
        </div>
      )}
    </div>
  );
}
