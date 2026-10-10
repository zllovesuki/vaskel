import { usePresence } from "@/client/features/presence/use-presence";
import { DraftBadge } from "@/client/features/drafts/badge";
import { useId, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Settings2, Sparkles, X } from "lucide-react";
import { membersOptions } from "@/client/api/members";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { useActivity } from "@/client/features/activity/use-activity";
import { channelIdentity } from "@/client/features/activity/model";
import { ownerIdentity } from "@/client/api/activity";
import { UnreadIndicator } from "@/client/features/activity/indicators";
import { NewChannelForm } from "@/client/features/workspace/new-channel-form";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { initial } from "@vaskel/ui/components/avatar";
import {
  buttonStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import {
  ChannelRow,
  CircleHeader,
  CircleUnreadCount,
  PeopleRow,
  UnreadMark,
} from "@vaskel/ui/components/home";
import { ActionsMenu } from "@/client/ui/actions-menu";
import { ModalDialog } from "@/client/ui/dialog";

/**
 * Current and new circles open automatically; only a deliberate expansion
 * is remembered, per device, never as account state.
 */
const EXPANDED_KEY = "vaskel.expanded";
function readExpanded(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}
function storeExpanded(serverId: string, expanded: boolean) {
  try {
    const ids = new Set(readExpanded());
    if (expanded) ids.add(serverId);
    else ids.delete(serverId);
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* Private windows may refuse storage; the section still toggles. */
  }
}

export function ServerNavigation({
  resource,
  activity,
  activeChannelId,
  peopleActive = false,
  settingsActive = false,
  onNavigate,
}: {
  resource: ResourceSummary;
  activity: ReturnType<typeof useActivity>;
  activeChannelId: string | undefined;
  peopleActive?: boolean;
  settingsActive?: boolean;
  onNavigate: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const current =
    activeChannelId !== undefined || peopleActive || settingsActive;
  const newToYou = activity.newOwners.has(ownerIdentity(resource.owner));
  const [expanded, setExpanded] = useState(
    () => current || newToYou || readExpanded().includes(resource.owner.id),
  );
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  // Arriving in a circle, or learning it is new to you, opens its section;
  // other circles keep their state, and a later manual collapse stands.
  const [arrival, setArrival] = useState({ current, newToYou });
  if (arrival.current !== current || arrival.newToYou !== newToYou) {
    setArrival({ current, newToYou });
    if ((current && !arrival.current) || (newToYou && !arrival.newToYou))
      setExpanded(true);
  }
  const channelsId = useId();
  const members = useQuery({
    ...membersOptions(user.userId, resource.owner),
    enabled: canUseNetwork,
    retry: false,
  });
  const presence = usePresence(resource.owner, expanded);
  const memberCount = members.data?.members.length;
  // Presence is about other people; the viewer knows they are here.
  const onlineCount = members.data?.members.filter(
    (m) => presence.state(m.userId) === "online" && m.userId !== user.userId,
  ).length;
  const activeChannel = resource.channels.find(
    (channel) => channel.id === activeChannelId,
  );
  const firstRoom = resource.channels.find(
    (channel) => channel.kind === "text",
  );
  const states = resource.channels
    .filter((channel) => channel.kind === "text")
    .map((channel) =>
      activity.states.get(channelIdentity(resource.owner, channel.id)),
    );
  const unreadCount = resource.channels
    .filter((channel) => channel.kind === "text")
    .reduce(
      (total, channel) =>
        total +
        (activity.counts.get(channelIdentity(resource.owner, channel.id)) ?? 0),
      0,
    );
  const unchecked = states.some(
    (state) => state !== "read" && state !== "unread",
  );
  return (
    <section className="not-first:mt-3">
      <CircleHeader
        toggle={(props) => (
          <button
            type="button"
            {...props}
            aria-expanded={expanded}
            aria-controls={channelsId}
            onClick={() => {
              setExpanded(!expanded);
              storeExpanded(resource.owner.id, !expanded);
            }}
          />
        )}
        name={resource.name}
        initial={initial(resource.name)}
        expanded={expanded}
        detail={
          !expanded && activeChannel
            ? `${activeChannel.kind === "media" ? "" : "# "}${activeChannel.name}`
            : undefined
        }
        marks={
          !expanded && (
            <>
              {newToYou && <UnreadMark kind="new" label={t("workspace.new")} />}
              {!newToYou && unreadCount > 0 && (
                <CircleUnreadCount
                  text={
                    unreadCount >= 100
                      ? `${formatNumber(99)}+`
                      : formatNumber(unreadCount)
                  }
                  label={t("workspace.unreadCount", {
                    count: formatNumber(unreadCount),
                  })}
                />
              )}
              {unchecked && (
                <span className="sr-only">{t("activity.unchecked")}</span>
              )}
            </>
          )
        }
      >
        {/* One control for the owner's two actions leaves the name its width. */}
        {resource.role === "owner" && (
          <ActionsMenu
            label={t("workspace.circleActions")}
            buttonLabel={t("workspace.circleActions")}
            items={[
              {
                id: "settings",
                label: t("workspace.circleSettings"),
                icon: <Settings2 className="size-4" aria-hidden="true" />,
                disabled: !canUseNetwork,
                onSelect: () => {
                  onNavigate();
                  void navigate({
                    to: "/servers/$serverId/settings",
                    params: { serverId: resource.owner.id },
                    search: {},
                  });
                },
              },
              {
                id: "add",
                label: t("workspace.addVoiceChannel"),
                icon: <Plus className="size-4" aria-hidden="true" />,
                onSelect: () => setAdding(true),
              },
            ]}
            buttonClass={buttonStyles({
              variant: "muted",
              size: "icon-small",
            })}
          />
        )}
        {adding && (
          <ModalDialog
            title={t("workspace.createRoomTitle", { name: resource.name })}
            close={() => setAdding(false)}
          >
            <NewChannelForm
              resource={resource}
              close={() => setAdding(false)}
            />
          </ModalDialog>
        )}
      </CircleHeader>
      <nav
        id={channelsId}
        hidden={!expanded}
        aria-label={t("workspace.channels", { name: resource.name })}
      >
        {newToYou && firstRoom && (
          <div className="mt-0.5 flex items-center gap-2.5 py-0.5 pl-2.5 text-caption leading-snug text-muted">
            <Sparkles
              className="size-4 shrink-0 text-accent"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1">
              {t("workspace.startHere", { room: `#${firstRoom.name}` })}
            </p>
            <button
              type="button"
              className={buttonStyles({
                variant: "muted",
                size: "icon-small",
              })}
              onClick={() => activity.dismissNew(ownerIdentity(resource.owner))}
            >
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">{t("workspace.dismissHint")}</span>
            </button>
          </div>
        )}
        <PeopleRow
          render={(props) => (
            <Link
              {...props}
              to="/servers/$serverId/people"
              params={{ serverId: resource.owner.id }}
              search={{}}
              onClick={onNavigate}
            />
          )}
          current={peopleActive}
          label={t("workspace.people")}
          detail={
            memberCount === undefined
              ? undefined
              : presence.completeFor(
                    members.data?.members.map((member) => member.userId) ?? [],
                  ) && onlineCount
                ? t("workspace.onlineCount", {
                    count: formatNumber(onlineCount),
                  })
                : formatNumber(memberCount)
          }
        />
        {resource.channels.map((channel) => {
          const key = channelIdentity(resource.owner, channel.id);
          const state =
            channel.kind === "text" ? activity.states.get(key) : undefined;
          const count = activity.counts.get(key) ?? 0;
          const mentions = activity.mentions.get(key) ?? 0;
          return (
            <ChannelRow
              key={channel.id}
              render={(props) => (
                <Link
                  {...props}
                  to="/servers/$serverId/channels/$channelId"
                  params={{
                    serverId: resource.owner.id,
                    channelId: channel.id,
                  }}
                  search={{}}
                  onClick={onNavigate}
                />
              )}
              kind={channel.kind}
              locked={channel.private}
              name={channel.name}
              current={activeChannelId === channel.id}
              unread={state === "unread"}
            >
              {channel.kind === "text" && (
                <>
                  <DraftBadge owner={resource.owner} channelId={channel.id} />
                  <UnreadIndicator
                    state={state}
                    count={count}
                    mentions={mentions}
                    quiet
                    fresh={activity.fresh.has(key)}
                  />
                </>
              )}
              {channel.kind === "media" && (
                <span className="sr-only">{t("workspace.voiceChannel")}</span>
              )}
              {channel.private && (
                <span className="sr-only">{t("workspace.privateChannel")}</span>
              )}
            </ChannelRow>
          );
        })}
      </nav>
      {expanded && activity.moreChannels.has(ownerIdentity(resource.owner)) && (
        <div className="px-2.5 text-caption text-muted">
          <button
            className={textButtonStyles({ size: "small" })}
            disabled={
              !activity.online ||
              (activity.channelLoadingOwner &&
                ownerIdentity(activity.channelLoadingOwner) ===
                  ownerIdentity(resource.owner))
            }
            onClick={() =>
              activity.checkChannels(
                resource.owner,
                activity.moreChannels.get(ownerIdentity(resource.owner))!,
              )
            }
          >
            {activity.channelErrorOwner &&
            ownerIdentity(activity.channelErrorOwner) ===
              ownerIdentity(resource.owner)
              ? t("workspace.retryChannelStatus")
              : t("workspace.moreChannelStatus")}
          </button>
        </div>
      )}
      {expanded &&
        activity.earlierChannelsOwner &&
        ownerIdentity(activity.earlierChannelsOwner) ===
          ownerIdentity(resource.owner) && (
          <button
            className={textButtonStyles({ size: "small", className: "px-2.5" })}
            disabled={!activity.online || Boolean(activity.channelLoadingOwner)}
            onClick={activity.restartChannels}
          >
            {t("workspace.earlierChannelStatus")}
          </button>
        )}
    </section>
  );
}
