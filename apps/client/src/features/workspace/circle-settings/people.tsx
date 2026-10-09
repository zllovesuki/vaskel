import { usePresence } from "@/client/features/presence/use-presence";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { ConfirmRow } from "@/client/ui/confirm-row";
import { roleOrder } from "@/client/features/workspace/circle-settings/model";
import { useStartConversation } from "@/client/features/workspace/start-conversation";
import { settingsListStyles } from "@/client/ui/settings-section";
import { PeopleSkeleton } from "@/client/ui/loading-skeleton";
import type { CircleResource, MemberState, PeopleState } from "./types";
import { useCommands } from "./commands";
import { MemberRow } from "./member-row";
import { Failure } from "@/client/ui/failure";

/** The roster as the owner administers it: the same rows as the People page, decisions in each row's menu. */
export function People({
  resource,
  members,
  people,
}: {
  resource: CircleResource;
  members: MemberState;
  people: PeopleState;
}) {
  const { t, language } = useI18n();
  const user = useUser();
  const presence = usePresence(resource.owner);
  const { canUseNetwork } = useAccess();
  const { run, busy } = useCommands();
  const [removing, setRemoving] = useState<string | null>(null);
  const start = useStartConversation();
  const role = useMutation({
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
  const collator = useMemo(() => new Intl.Collator(language), [language]);
  const rows = [...(members.data?.members ?? [])].sort(
    (a, b) =>
      roleOrder[a.role] - roleOrder[b.role] ||
      collator.compare(
        people.names.get(a.userId) ?? a.userId,
        people.names.get(b.userId) ?? b.userId,
      ),
  );
  const blocked = !canUseNetwork || busy;
  return (
    <>
      {members.loading && (
        <PeopleSkeleton
          label={t("workspace.loadingPeople")}
          action="menu"
          className={settingsListStyles}
          rowClassName="py-2.5"
        />
      )}
      <Failure error={start.error} />
      <Failure error={role.error} />
      <Failure error={remove.error} />
      <ul className={settingsListStyles}>
        {rows.map((member) => {
          const self = member.userId === user.userId;
          const name = people.names.get(member.userId) ?? t("chat.member");
          const decides = !self && member.role !== "owner";
          return (
            <li key={member.userId} className="py-2.5">
              <MemberRow
                member={member}
                presence={presence.state(member.userId)}
                name={name}
                self={self}
                menu={
                  self
                    ? undefined
                    : [
                        {
                          id: "message",
                          label: t("workspace.message"),
                          disabled: !canUseNetwork || start.isPending,
                          onSelect: () => start.mutate(member.userId),
                        },
                        ...(decides
                          ? [
                              {
                                id: "role",
                                label:
                                  member.role === "moderator"
                                    ? t("workspace.removeModerator")
                                    : t("workspace.makeModerator"),
                                disabled: blocked,
                                onSelect: () =>
                                  role.mutate({
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
                          : []),
                      ]
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
    </>
  );
}
