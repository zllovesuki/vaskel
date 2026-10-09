import { NavigationToggle } from "@vaskel/ui/components/home";
import {
  Bone,
  FieldSkeleton,
  Line,
  PeopleSkeleton,
  Placeholder,
} from "@/client/ui/loading-skeleton";
import { useQuery } from "@tanstack/react-query";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { errorMessage } from "@/client/api/client";
import { membersOptions } from "@/client/api/members";
import { administrationOptions } from "@/client/api/administration";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonRowStyles,
  buttonStyles,
  chatHeaderStyles,
  formStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";
import { Unavailable } from "@/client/ui/failure";
import {
  SettingsSection as Section,
  settingsBodyStyles,
  settingsColumnStyles,
  settingsListStyles,
} from "@/client/ui/settings-section";
import type { MemberState, PeopleState } from "./types";
import { CommandsContext, useCircleCommands } from "./commands";
import { Avatar } from "@vaskel/ui/components/avatar";
import { Overview } from "./overview";
import { Rooms } from "./rooms";
import { People } from "./people";
import { Invitations } from "./invitations";
import { Transfer } from "./ownership";

/** Everything the owner of one circle decides, in one column of sections. */
export function CircleSettingsPage({
  resource,
  onNavigation,
}: {
  resource: ResourceSummary;
  onNavigation: () => void;
}) {
  const { t, text, formatNumber } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const owner = resource.role === "owner";
  const commands = useCircleCommands(resource.owner.id, user.userId);
  const administration = useQuery({
    ...administrationOptions(user.userId, resource.owner.id),
    enabled: canUseNetwork && owner,
  });
  const members = useQuery({
    ...membersOptions(user.userId, resource.owner),
    enabled: canUseNetwork && owner,
    retry: false,
  });
  const ids = members.data?.members.map((member) => member.userId) ?? [];
  const people = useDisplayNames(ids, { includeViewer: true, enabled: owner });
  const memberState: MemberState = {
    data: members.data,
    loading: members.isPending && canUseNetwork,
    failed: Boolean(members.error),
  };
  const peopleState: PeopleState = {
    names: people.names,
    // Names for other members are still on their way, or never arrived.
    loading: ids.length > 1 && people.isPending,
    failed: Boolean(people.error),
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("workspace.circleSettings")}
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
            {t("workspace.circleSettings")}
          </h1>
          <p className="truncate text-caption text-muted">
            {resource.name}
            {members.data
              ? ` · ${t("workspace.peopleCount", { count: formatNumber(members.data.members.length) })}`
              : ""}
          </p>
        </div>
      </header>
      <div className={settingsBodyStyles}>
        <div className={settingsColumnStyles}>
          {!owner ? (
            <p role="status" className={noticeStyles({ className: "mt-5" })}>
              {t("workspace.ownerOnly")}
            </p>
          ) : (
            <CommandsContext value={commands}>
              {!canUseNetwork && (
                <p
                  role="status"
                  className={noticeStyles({ className: "mt-5" })}
                >
                  {t("chat.checkingAccess")}
                </p>
              )}
              {members.error && (
                <Unavailable
                  className="mt-5"
                  message={t("workspace.peopleUnavailable")}
                  onRetry={() => void members.refetch()}
                  disabled={!canUseNetwork}
                />
              )}
              {administration.isPending && canUseNetwork && (
                <>
                  <Section title={t("workspace.overview")}>
                    <Placeholder
                      label={t("workspace.loading")}
                      kind="form"
                      className={formStyles}
                    >
                      <FieldSkeleton label={t("workspace.serverName")} />
                      <div className={buttonRowStyles}>
                        <button
                          className={buttonStyles({
                            variant: "primary",
                            size: "small",
                          })}
                          disabled
                        >
                          {t("workspace.save")}
                        </button>
                      </div>
                      <FieldSkeleton
                        control="checkbox"
                        label={t("workspace.membersMayInvite")}
                        hint={t("workspace.membersMayInviteHint")}
                      />
                    </Placeholder>
                  </Section>
                  <Section
                    title={t("workspace.rooms")}
                    description={t("workspace.roomsHint")}
                    width="full"
                  >
                    <Placeholder
                      label={t("workspace.loading")}
                      kind="rooms"
                      className={settingsListStyles}
                    >
                      {["w-24", "w-32", "w-20"].map((width) => (
                        <div key={width} className="py-1.5">
                          <div className="flex min-h-target items-center gap-2.5">
                            <Bone className="size-4 rounded-sm" />
                            <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                              <Line width={width} />
                              <Line size="caption" width="w-56" />
                            </span>
                            <Bone className="size-control-compact pointer-coarse:size-control-touch" />
                            <Bone className="size-control-compact pointer-coarse:size-control-touch" />
                            <Bone className="h-target w-12" />
                          </div>
                        </div>
                      ))}
                    </Placeholder>
                  </Section>
                  <Section title={t("workspace.people")} width="full">
                    <PeopleSkeleton
                      label={t("workspace.loadingPeople")}
                      action="menu"
                      className={settingsListStyles}
                      rowClassName="py-2.5"
                    />
                  </Section>
                </>
              )}
              {administration.error && (
                <Unavailable
                  className="mt-5"
                  message={text(errorMessage(administration.error))}
                  onRetry={() => void administration.refetch()}
                  disabled={!canUseNetwork}
                />
              )}
              {administration.data && (
                <>
                  <Section title={t("workspace.overview")}>
                    <Overview
                      key={administration.data.name}
                      resource={administration.data}
                    />
                  </Section>
                  <Section
                    title={t("workspace.rooms")}
                    description={t("workspace.roomsHint")}
                    width="full"
                  >
                    <Rooms
                      resource={administration.data}
                      members={memberState}
                      people={peopleState}
                    />
                  </Section>
                  <Section title={t("workspace.people")} width="full">
                    <People
                      resource={administration.data}
                      members={memberState}
                      people={peopleState}
                    />
                  </Section>
                  <Section title={t("workspace.invitations")} width="full">
                    <Invitations
                      resource={administration.data}
                      people={peopleState}
                    />
                  </Section>
                  <Section
                    title={t("workspace.transferOwnership")}
                    description={t("workspace.transferHint")}
                  >
                    <Transfer
                      resource={administration.data}
                      members={memberState}
                      people={peopleState}
                    />
                  </Section>
                </>
              )}
            </CommandsContext>
          )}
        </div>
      </div>
    </section>
  );
}
