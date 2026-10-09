import { PendingLabel, Placeholder } from "@/client/ui/loading-skeleton";
import { SidebarRows } from "@/client/ui/workspace-skeleton";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  sidebarBodyStyles,
  textButtonStyles,
  workspaceSidebarStyles,
} from "@vaskel/ui/components/control-styles";
import {
  HomeHeader,
  HomeSection,
  NavigationToggle,
  SearchRow,
  Wordmark,
} from "@vaskel/ui/components/home";
import { Plus } from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { useRoutePage } from "@/client/routes/route-page";
import { errorMessage } from "@/client/api/client";
import { useAccess } from "@/client/features/cache/access/context";
import { ServerNavigation } from "@/client/features/workspace/server-navigation";
import { DialogButton } from "@/client/ui/dialog";
import { Unavailable } from "@/client/ui/failure";
import { JoinForm } from "@/client/features/workspace/join-form";
import { NewServerForm } from "@/client/features/workspace/new-server-form";
import { PeoplePicker } from "@/client/features/workspace/people-picker";
import { ActivityNavigation } from "@/client/features/activity/indicators";
import { channelIdentity } from "@/client/features/activity/model";
import { HappeningNow } from "@/client/features/workspace/happening-now";
import { CallDock } from "@/client/features/media/call-dock";
import { DirectRow } from "@/client/features/workspace/direct-row";
import type { RefObject } from "react";
import type { WorkspaceNavigation } from "./use-navigation";
import { AccountMenu } from "./account-menu";

export function WorkspaceSidebar({
  navigation,
  mobileOpen,
  closeNavigation,
  onNavigate,
}: {
  navigation: WorkspaceNavigation;
  mobileOpen: boolean;
  closeNavigation: RefObject<HTMLButtonElement | null>;
  onNavigate: () => void;
}) {
  const { t, text, formatNumber } = useI18n();
  const access = useAccess();
  const { directory, resources, activity, canCreate } = navigation;
  const page = useRoutePage();
  const params = useParams({ strict: false });
  const servers = resources.filter(
    (resource) => resource.owner.kind === "server",
  );
  const conversations = resources.filter(
    (resource) => resource.owner.kind === "conversation",
  );

  return (
    <aside
      className={workspaceSidebarStyles}
      aria-label={t("workspace.conversations")}
      onClickCapture={(event) => {
        if (
          !access.canUseNetwork &&
          event.target instanceof Element &&
          event.target.closest("a[href]")
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (mobileOpen && event.key === "Escape") onNavigate();
      }}
    >
      <HomeHeader
        wordmark={
          <Wordmark
            render={(props) => <Link {...props} to="/" search={{}} />}
          />
        }
        close={
          <NavigationToggle
            action="close"
            ref={closeNavigation}
            label={t("workspace.closeConversations")}
            onClick={() => onNavigate()}
          />
        }
        add={
          <DialogButton
            label={
              <>
                <Plus aria-hidden="true" />
                <span className="sr-only">{t("workspace.addServer")}</span>
              </>
            }
            buttonClass={buttonStyles({ variant: "quiet", size: "icon" })}
            title={t("workspace.addServer")}
            description={t("workspace.circleExplainer")}
          >
            {(close) => (
              <div className="flex flex-col gap-5">
                <section className="flex flex-col gap-3">
                  <h3 className="text-ui font-semibold">
                    {t("workspace.joinServer")}
                  </h3>
                  <JoinForm close={close} />
                </section>
                {canCreate && (
                  <section className="flex flex-col gap-3 border-t border-line pt-5">
                    <h3 className="text-ui font-semibold">
                      {t("workspace.createServer")}
                    </h3>
                    <NewServerForm close={close} />
                  </section>
                )}
              </div>
            )}
          </DialogButton>
        }
        account={<AccountMenu onNavigate={onNavigate} />}
      />
      <div className={sidebarBodyStyles}>
        <SearchRow
          render={(props) => (
            <Link
              {...props}
              to="/search"
              search={{}}
              onClick={() => onNavigate()}
            />
          )}
          current={page === "search"}
          label={t("search.title")}
        />
        <HappeningNow resources={resources} onNavigate={() => onNavigate()} />
        <ActivityNavigation
          activity={activity}
          onNavigate={() => onNavigate()}
        />
        <HomeSection
          className="not-first:mt-4"
          label={t("workspace.servers")}
          count={formatNumber(servers.length)}
        >
          {directory.isPending && (
            <Placeholder
              label={t("workspace.loadingConversations")}
              kind="directory"
            >
              <SidebarRows rows={["w-[60%]", "w-[45%]", "w-[55%]"]} />
            </Placeholder>
          )}
          {directory.error && (
            <Unavailable
              className="px-2.5 py-1.5 leading-relaxed"
              message={text(errorMessage(directory.error))}
              onRetry={() => void directory.refetch()}
              disabled={!access.canUseNetwork}
            />
          )}
          {servers.map((resource) => (
            <ServerNavigation
              key={resource.owner.id}
              resource={resource}
              activity={activity}
              activeChannelId={
                params.serverId === resource.owner.id
                  ? params.channelId
                  : undefined
              }
              peopleActive={
                page === "people" && params.serverId === resource.owner.id
              }
              settingsActive={
                page === "circleSettings" &&
                params.serverId === resource.owner.id
              }
              onNavigate={() => onNavigate()}
            />
          ))}
          {directory.isSuccess && !servers.length && (
            <p className="px-2.5 py-1.5 text-caption leading-relaxed text-muted">
              {t("workspace.noServers")}
            </p>
          )}
        </HomeSection>
        <HomeSection
          className="not-first:mt-4"
          label={t("workspace.directMessages")}
          action={
            <DialogButton
              label={
                <>
                  <Plus className="size-4" aria-hidden="true" />
                  <span className="sr-only">
                    {t("workspace.newDirectMessage")}
                  </span>
                </>
              }
              buttonClass={buttonStyles({
                variant: "muted",
                size: "icon-small",
              })}
              title={t("workspace.startConversation")}
            >
              {(close) => <PeoplePicker close={close} />}
            </DialogButton>
          }
        >
          <nav aria-label={t("workspace.directMessages")}>
            {conversations.map((resource) => {
              const key = channelIdentity(
                resource.owner,
                resource.channels[0]?.id ?? "",
              );
              return (
                <DirectRow
                  key={resource.owner.id}
                  resource={resource}
                  active={params.conversationId === resource.owner.id}
                  state={activity.states.get(key)}
                  count={activity.counts.get(key) ?? 0}
                  mentions={activity.mentions.get(key) ?? 0}
                  onNavigate={() => onNavigate()}
                />
              );
            })}
          </nav>
          {directory.isSuccess && !conversations.length && (
            <p className="px-2.5 py-1.5 text-caption leading-relaxed text-muted">
              {t("workspace.noDirectMessages")}
            </p>
          )}
        </HomeSection>
        {directory.hasNextPage && (
          <button
            className={textButtonStyles({
              size: "small",
              className: "mx-2.5 my-3",
            })}
            disabled={!access.canUseNetwork || directory.isFetchingNextPage}
            aria-busy={directory.isFetchingNextPage}
            onClick={() => void directory.fetchNextPage()}
          >
            <PendingLabel
              pending={directory.isFetchingNextPage}
              label={t("workspace.loading")}
            >
              {t("workspace.loadMore")}
            </PendingLabel>
          </button>
        )}
        {directory.data?.pages.some((page) => page.partial) && (
          <Unavailable
            role="status"
            className="px-2.5 py-1.5 leading-relaxed"
            message={t("workspace.partialDirectory")}
            onRetry={() => void directory.refetch()}
            disabled={!access.canUseNetwork}
          />
        )}
      </div>
      <CallDock />
    </aside>
  );
}
