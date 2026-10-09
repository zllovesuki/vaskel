import { usePresence } from "@/client/features/presence/use-presence";
import { PeopleSkeleton } from "@/client/ui/loading-skeleton";
import { NavigationToggle } from "@vaskel/ui/components/home";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { membersOptions } from "@/client/api/members";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Avatar } from "@vaskel/ui/components/avatar";
import { MemberRow } from "@/client/features/workspace/circle-settings/member-row";
import { useCircleCommands } from "@/client/features/workspace/circle-settings/commands";
import { roleOrder } from "@/client/features/workspace/circle-settings/model";
import { ConfirmRow } from "@/client/ui/confirm-row";
import { InviteForm } from "@/client/features/workspace/invite-form";
import { useStartConversation } from "@/client/features/workspace/start-conversation";
import { DialogButton } from "@/client/ui/dialog";
import { Failure, Unavailable } from "@/client/ui/failure";
import {
  buttonStyles,
  chatHeaderStyles,
} from "@vaskel/ui/components/control-styles";

/** The people of one circle, as its owner actor authorizes them. */
export function PeoplePage({
  resource,
  onNavigation,
}: {
  resource: ResourceSummary;
  onNavigation: () => void;
}) {
  const { t, language, formatNumber } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const { run, busy } = useCircleCommands(resource.owner.id, user.userId);
  const blocked = !canUseNetwork || busy;
  const members = useQuery({
    ...membersOptions(user.userId, resource.owner),
    enabled: canUseNetwork,
    retry: false,
  });
  const presence = usePresence(resource.owner);
  const ids = members.data?.members.map((member) => member.userId) ?? [];
  const { names } = useDisplayNames(ids, { includeViewer: true });
  const collator = useMemo(() => new Intl.Collator(language), [language]);
  const rows = [...(members.data?.members ?? [])].sort((a, b) => {
    // Online first, then by role, then the viewer, then names in the viewer's
    // language. No last-seen order: presence is now or nothing.
    const aOnline = presence.state(a.userId) === "online";
    const bOnline = presence.state(b.userId) === "online";
    if (aOnline !== bOnline) return aOnline ? -1 : 1;
    if (a.role !== b.role) return roleOrder[a.role] - roleOrder[b.role];
    if (a.userId === user.userId) return -1;
    if (b.userId === user.userId) return 1;
    return collator.compare(
      names.get(a.userId) ?? a.userId,
      names.get(b.userId) ?? b.userId,
    );
  });
  const onlineCount =
    members.data?.members.filter(
      (member) => presence.state(member.userId) === "online",
    ).length ?? 0;
  const start = useStartConversation();
  const [removing, setRemoving] = useState<string | null>(null);
  const setRole = useMutation({
    mutationFn: (variables: { userId: string; role: "member" | "moderator" }) =>
      run({
        action: "set-role",
        body: { ...variables, expectedVersion: resource.version },
      }),
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      run({
        action: "remove-member",
        body: { userId, expectedVersion: resource.version },
      }),
    onSuccess: () => setRemoving(null),
  });
  const owner = resource.role === "owner";
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("workspace.people")}
    >
      <header className={chatHeaderStyles}>
        <NavigationToggle
          action="open"
          label={t("chat.openConversations")}
          onClick={onNavigation}
        />
        <Avatar name={resource.name} />
        <div className="mr-auto min-w-0">
          <h1 className="text-base font-semibold wrap-anywhere">
            {t("workspace.people")}
          </h1>
          <p className="truncate text-caption text-muted">
            {resource.name}
            {members.data
              ? ` · ${t("workspace.peopleCount", { count: formatNumber(members.data.members.length) })} · ${presence.completeFor(members.data?.members.map((member) => member.userId) ?? []) ? t("workspace.onlineCount", { count: formatNumber(onlineCount) }) : t("workspace.presenceUnavailable")}`
              : ""}
          </p>
        </div>
        {resource.canCreateInvite && (
          <DialogButton
            label={
              <>
                <UserPlus className="size-4" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">
                  {t("workspace.invitePeople")}
                </span>
              </>
            }
            buttonClass={buttonStyles({
              variant: "quiet",
              size: "small",
              className: "max-sm:px-2",
            })}
            title={t("workspace.invitePeople")}
          >
            {() => <InviteForm serverId={resource.owner.id} />}
          </DialogButton>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-page-gutter py-3">
        {members.isPending && canUseNetwork && (
          <PeopleSkeleton
            label={t("workspace.loadingPeople")}
            action="button"
            rowClassName="px-2 py-1.5"
          />
        )}
        {!canUseNetwork && (
          <p role="status" className="text-caption text-muted">
            {t("chat.checkingAccess")}
          </p>
        )}
        {members.error && (
          <Unavailable
            message={t("workspace.peopleUnavailable")}
            onRetry={() => void members.refetch()}
            disabled={!canUseNetwork}
          />
        )}
        <Failure
          className="mb-2"
          error={start.error ?? remove.error ?? setRole.error}
        />
        <ul className="flex flex-col gap-1">
          {rows.map((member) => {
            const self = member.userId === user.userId;
            const name = names.get(member.userId) ?? t("chat.member");
            return (
              <li key={member.userId} className="px-2 py-1.5">
                <MemberRow
                  member={member}
                  presence={presence.state(member.userId)}
                  name={name}
                  self={self}
                  primary={
                    !self && (
                      <button
                        className={buttonStyles({ size: "small" })}
                        disabled={!canUseNetwork || start.isPending}
                        onClick={() => start.mutate(member.userId)}
                      >
                        {t("workspace.message")}
                      </button>
                    )
                  }
                  menu={
                    owner && !self && member.role !== "owner"
                      ? [
                          {
                            id: "role",
                            label:
                              member.role === "moderator"
                                ? t("workspace.removeModerator")
                                : t("workspace.makeModerator"),
                            disabled: blocked,
                            onSelect: () =>
                              setRole.mutate({
                                userId: member.userId,
                                role:
                                  member.role === "moderator"
                                    ? "member"
                                    : "moderator",
                              }),
                          },
                          {
                            id: "remove",
                            label: t("workspace.removeFromCircle"),
                            destructive: true,
                            disabled: blocked,
                            onSelect: () => setRemoving(member.userId),
                          },
                        ]
                      : undefined
                  }
                  confirm={
                    removing === member.userId && (
                      <ConfirmRow
                        question={t("workspace.removeConfirm", { name })}
                        confirmLabel={t("workspace.removeFromCircle")}
                        busyLabel={t("workspace.removing")}
                        busy={remove.isPending}
                        disabled={blocked}
                        onConfirm={() => remove.mutate(member.userId)}
                        onCancel={() => setRemoving(null)}
                      />
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
