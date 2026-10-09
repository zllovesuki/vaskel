import { PendingLabel, RowsSkeleton } from "@/client/ui/loading-skeleton";
import { UserPlus } from "lucide-react";
import { InviteForm } from "@/client/features/workspace/invite-form";
import { DialogButton } from "@/client/ui/dialog";
import { Failure, Unavailable } from "@/client/ui/failure";
import type { CircleResource, PeopleState } from "./types";
import { api } from "@/client/api/contract";
import { useCallback, useSyncExternalStore } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { invitesKey } from "@/client/api/client";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";

import { inviteState } from "@/client/features/workspace/circle-settings/model";

import {
  buttonRowStyles,
  buttonStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import {
  settingsListStyles,
  settingsRowStyles,
} from "@/client/ui/settings-section";

import { postCommand } from "./commands";

const clockListeners = new Set<() => void>();

let clockTimer: ReturnType<typeof setInterval> | undefined;

/** A shared minute tick, so an invitation does not stay "active" past its hour. */
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  clockTimer ??= setInterval(
    () => clockListeners.forEach((fn) => fn()),
    60_000,
  );
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

const minute = () => Math.floor(Date.now() / 60_000) * 60_000;

export function Invitations({
  resource,
  people,
}: {
  resource: CircleResource;
  people: PeopleState;
}) {
  const { t, formatNumber, formatDateTime } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const client = useQueryClient();
  const id = resource.owner.id;
  const refresh = useCallback(async () => {
    await client.invalidateQueries({
      queryKey: invitesKey(user.userId, id),
    });
  }, [client, id, user.userId]);
  const invites = useInfiniteQuery({
    queryKey: invitesKey(user.userId, id),
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.invites(
        { params: { id: id }, query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    enabled: canUseNetwork,
    staleTime: 30_000,
    retry: false,
  });
  const revoke = useMutation({
    // Revoking carries no version, so it does not wait on the owner commands.
    mutationFn: async (tokenHash: string) => {
      await postCommand(id, { action: "revoke-invite", body: { tokenHash } });
    },
    onSettled: refresh,
  });
  const rows = invites.data?.pages.flatMap((page) => page.invites) ?? [];
  const missing = [
    ...new Set(
      rows
        .map((invite) => invite.creatorId)
        .filter((creatorId) => !people.names.has(creatorId)),
    ),
  ];
  const creators = useDisplayNames(missing);
  const creatorName = (userId: string) =>
    people.names.get(userId) ?? creators.names.get(userId) ?? t("chat.member");
  // Expiry is read against a ticking clock, not against the moment the list
  // arrived, so a row stops offering Revoke once the invitation runs out.
  const now = useSyncExternalStore(subscribeClock, minute, minute);
  return (
    <>
      <div className={buttonRowStyles}>
        <DialogButton
          label={
            <>
              <UserPlus className="size-4" aria-hidden="true" />
              {t("workspace.createInvitation")}
            </>
          }
          buttonClass={buttonStyles({ size: "small" })}
          title={t("workspace.createInvitation")}
        >
          {() => <InviteForm serverId={id} />}
        </DialogButton>
      </div>
      {invites.isPending && canUseNetwork && (
        <RowsSkeleton label={t("workspace.loadingInvitations")} rows={2} />
      )}
      {invites.error && (
        <Unavailable
          message={t("workspace.invitationsUnavailable")}
          onRetry={() => void invites.refetch()}
          disabled={!canUseNetwork}
        />
      )}
      <Failure error={revoke.error} />
      {invites.data && rows.length === 0 && (
        <p className="text-caption text-muted">
          {t("workspace.noInvitations")}
        </p>
      )}
      <ul className={settingsListStyles}>
        {rows.map((invite) => {
          const state = inviteState(invite, now);
          // Each Revoke is named by the invitation it closes, not by "Revoke".
          const describedBy = `invite-${invite.tokenHash}`;
          return (
            <li key={invite.tokenHash} className={settingsRowStyles}>
              <span className="min-w-0 flex-1 basis-48 leading-tight">
                <span className="block text-ui" id={describedBy}>
                  {t("workspace.inviteCreatedBy", {
                    name: creatorName(invite.creatorId),
                    date: formatDateTime(invite.createdAt),
                  })}
                </span>
                <span className="block text-caption text-muted">
                  {t("workspace.inviteUses", {
                    used: formatNumber(invite.uses),
                    total: formatNumber(invite.maxUses),
                  })}
                  {" · "}
                  {t("workspace.inviteExpires", {
                    date: formatDateTime(invite.expiresAt),
                  })}
                </span>
              </span>
              <span
                className={`text-caption ${state === "active" ? "text-ink" : "text-muted"}`}
              >
                {t(
                  state === "revoked"
                    ? "workspace.inviteRevoked"
                    : state === "usedUp"
                      ? "workspace.inviteUsedUp"
                      : state === "expired"
                        ? "workspace.inviteExpired"
                        : "workspace.inviteActive",
                )}
              </span>
              {state === "active" && (
                <button
                  type="button"
                  className={buttonStyles({
                    variant: "danger",
                    size: "small",
                  })}
                  aria-describedby={describedBy}
                  disabled={!canUseNetwork || revoke.isPending}
                  onClick={() => revoke.mutate(invite.tokenHash)}
                >
                  {revoke.isPending && revoke.variables === invite.tokenHash
                    ? t("workspace.revoking")
                    : t("workspace.revokeInvite")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {invites.hasNextPage && (
        <button
          className={textButtonStyles({ size: "small" })}
          disabled={!canUseNetwork || invites.isFetchingNextPage}
          aria-busy={invites.isFetchingNextPage}
          onClick={() => void invites.fetchNextPage()}
        >
          <PendingLabel
            pending={invites.isFetchingNextPage}
            label={t("workspace.loading")}
          >
            {t("workspace.loadMoreInvitations")}
          </PendingLabel>
        </button>
      )}
    </>
  );
}
