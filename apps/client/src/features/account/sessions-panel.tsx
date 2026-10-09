import { RowsSkeleton } from "@/client/ui/loading-skeleton";
import { Unavailable } from "@/client/ui/failure";
import { ConfirmRow } from "@/client/ui/confirm-row";
import { apiFailure } from "@/client/api/errors";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  revokeSession,
  sessionsKey,
  sessionsOptions,
} from "@/client/api/account";
import { errorMessage } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { orderSessions } from "./sessions";
import {
  buttonStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";

import { settingsListStyles } from "@/client/ui/settings-section";

/** Every browser signed in to this account, this device first. */
export function SessionsPanel() {
  const { t, text, formatDateTime } = useI18n();
  const user = useUser();
  const { canUseNetwork, logout } = useAccess();
  const client = useQueryClient();
  const sessions = useQuery({
    ...sessionsOptions(user.userId),
    enabled: canUseNetwork,
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const revoke = useMutation({
    mutationKey: [...sessionsKey(user.userId), "revoke"],
    networkMode: "always",
    retry: false,
    mutationFn: revokeSession,
    onSuccess: async (result) => {
      // A stale row can name this very session; end it here as well as there.
      if (result.current) await logout();
    },
    onSettled: async () => {
      // A row can name a session that is already gone. The confirmation closes
      // and the list refreshes whether the revoke was accepted or refused, and
      // focus moves to the list rather than to a row that may not return.
      setConfirming(null);
      list.current?.focus();
      await client.invalidateQueries({ queryKey: sessionsKey(user.userId) });
    },
  });
  const alreadyRevoked =
    apiFailure(revoke.error) &&
    apiFailure(revoke.error)?.code === "invalid_request";
  const rows = orderSessions(sessions.data?.sessions ?? []);
  return (
    <div className="flex flex-col gap-3">
      {sessions.isPending && canUseNetwork && (
        <RowsSkeleton label={t("account.sessionsLoading")} rows={2} />
      )}
      {sessions.error && (
        <Unavailable
          message={t("account.sessionsUnavailable")}
          onRetry={() => void sessions.refetch()}
          disabled={!canUseNetwork}
        />
      )}
      {sessions.data?.partial && (
        <p role="status" className={noticeStyles()}>
          {t("account.sessionsPartial")}
        </p>
      )}
      {revoke.error && (
        <p role="alert" className={noticeStyles({ error: true })}>
          {alreadyRevoked
            ? t("account.sessionAlreadyRevoked")
            : text(errorMessage(revoke.error))}
        </p>
      )}
      <ul
        ref={list}
        tabIndex={-1}
        aria-label={t("account.sessions")}
        className={`${settingsListStyles} focus-visible:outline-none`}
      >
        {rows.map((session) => {
          const name =
            session.userAgentFamily === "Other"
              ? t("account.browserOther")
              : session.userAgentFamily;
          return (
            <li key={session.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1 leading-snug">
                  <span className="flex items-center gap-2 text-ui font-medium">
                    <span className="truncate">{name}</span>
                    {session.current && (
                      <span className="rounded-full bg-subtle px-2 py-0.5 text-fine font-semibold text-muted">
                        {t("account.thisDevice")}
                      </span>
                    )}
                  </span>
                  <span className="block text-caption text-muted">
                    {t("account.sessionStarted", {
                      date: formatDateTime(session.createdAt),
                    })}
                  </span>
                </span>
                <button
                  className={buttonStyles({
                    size: "small",
                    // While its question is open, the question holds the only Sign out.
                    className: confirming === session.id ? "invisible" : "",
                  })}
                  disabled={!canUseNetwork || revoke.isPending}
                  aria-label={t("account.revokeSessionNamed", { name })}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    setConfirming(session.id);
                  }}
                >
                  {t("account.revokeSession")}
                </button>
              </div>
              {confirming === session.id && (
                <ConfirmRow
                  question={
                    session.current
                      ? t("account.revokeCurrentConfirm")
                      : t("account.revokeConfirm", { name })
                  }
                  confirmLabel={t("account.revokeSession")}
                  busyLabel={t("account.revoking")}
                  busy={revoke.isPending}
                  disabled={!canUseNetwork}
                  onConfirm={() => revoke.mutate(session.id)}
                  // Cancelling returns focus to the control that opened it.
                  returnFocus={trigger}
                  onCancel={() => setConfirming(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
