import { useConversationSearch } from "./use-conversation-search";
import {
  ConversationSearchControl,
  ConversationSearchResults,
} from "./conversation-search";
import { RoomNotificationControl } from "@/client/features/notifications/room-control";
import { NavigationToggle } from "@vaskel/ui/components/home";
import { SkipLink } from "@/client/ui/skip-link";
import {
  ComposerSkeleton,
  TimelineSkeleton,
} from "@/client/ui/workspace-skeleton";
import { RoomHeader } from "@vaskel/ui/components/room";
import { UserPlus } from "lucide-react";
import { ForwardPicker } from "@/client/features/chat/forward-picker";
import { DraftComposer } from "@/client/features/drafts/composer";
import { MessageWorkProvider } from "./message-work-provider";
import { TimelineView } from "@/client/features/chat/timeline-view";
import { TimelineJump } from "@/client/features/chat/timeline-jump";
import { DialogButton } from "@/client/ui/dialog";
import { StatusStrip } from "@/client/ui/status-strip";
import { InviteForm } from "@/client/features/workspace/invite-form";
import { PresenceStrip } from "@/client/features/workspace/presence-strip";
import { DirectBlockControl } from "@/client/features/blocking/direct-block-control";
import { JoinCallButton } from "@/client/features/media/room-panel";
import { DirectCallPanel } from "@/client/features/media/direct-call-panel";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { type Message } from "@vaskel/contracts/messaging";
import { type ConversationRead } from "./timeline-presentation";

import { useViewingLock } from "@/client/features/notifications/use-viewing-lock";

import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  emptyStateStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import { personHue } from "@vaskel/ui/components/avatar";
import { timelineSkeletonFrameStyles } from "@/client/ui/workspace-skeleton";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { errorMessage, failureMessage } from "@/client/api/client";
import { blockPollInterval, directBlockOptions } from "@/client/api/blocks";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useUser } from "@/client/features/auth/session-state";
import { useOnline, useTimeline } from "@/client/features/chat/use-timeline";
import { canInteractWithTimeline } from "./timeline-presentation";

import {
  selectQuote,
  type QuoteSelection,
} from "@/client/features/chat/quote-selection";

import { useDraftManager } from "@/client/features/drafts/context";

import { hasNewerMessages } from "@/client/features/chat/reconcile";

import { conversationCounterparts } from "@/client/features/workspace/conversation-title";

export function ChatPanel({
  resource,
  channelId,
  onNavigation,
}: {
  resource: ResourceSummary;
  channelId: string;
  onNavigation: () => void;
}) {
  const { t, text, language } = useI18n();

  const user = useUser();
  const inbox = useAccountEvents();
  const drafts = useDraftManager();
  const [forwardSelection, setForwardSelection] =
    useState<QuoteSelection | null>(null);
  const networkOnline = useOnline();
  const directPolicy = useQuery({
    ...directBlockOptions(
      user.userId,
      resource.owner.id,
      blockPollInterval(inbox.connected),
    ),
    enabled: networkOnline && resource.owner.kind === "conversation",
  });
  useViewingLock(resource.owner, channelId);
  const timeline = useTimeline(resource.owner, channelId, {
    owner: resource.name,
    channel:
      resource.channels.find((item) => item.id === channelId)?.name ??
      resource.name,
  });
  const { view } = timeline;
  const interactive = canInteractWithTimeline(view);
  const channel = resource.channels.find((item) => item.id === channelId);
  const title =
    resource.owner.kind === "conversation"
      ? resource.name
      : (channel?.name ?? t("chat.conversation"));
  const names = timeline.names;
  const typingNames = timeline.typing.map(
    (id) => names.get(id) ?? t("chat.member"),
  );
  const search = useConversationSearch(
    resource.owner,
    channelId,
    interactive,
    timeline.jumpTo,
  );
  if (view.kind === "denied" && forwardSelection) setForwardSelection(null);
  const draftTarget = {
    owner: resource.owner,
    channelId,
    label:
      resource.owner.kind === "server" ? `#${title} · ${resource.name}` : title,
  };
  function renderContent() {
    switch (view.kind) {
      case "denied":
        return (
          <div className={emptyStateStyles}>
            <h2>{t("chat.accessChanged")}</h2>
            <p>{text(failureMessage(view.reason))}</p>
            <p className="text-muted">{t("chat.chooseConversation")}</p>
          </div>
        );
      case "loading":
        return (
          <>
            <div role="status" className={timelineSkeletonFrameStyles}>
              <span className="sr-only">{t("chat.loadingConversation")}</span>
              <TimelineSkeleton />
            </div>
            <ComposerSkeleton />
          </>
        );
      case "failed":
        return (
          <div className={emptyStateStyles}>
            <h2>{t("chat.loadFailed")}</h2>
            <p>{text(errorMessage(view.error))}</p>
            <button
              className={buttonStyles()}
              disabled={view.retry === null}
              onClick={() => void view.retry?.()}
            >
              {t("common.tryAgain")}
            </button>
          </div>
        );
      case "conversation": {
        const { read } = view;
        return (
          <>
            <SnapshotRefreshNotice state={read.interaction} />
            {interactive && search.query && (
              <ConversationSearchResults
                search={search}
                owner={resource.owner}
                names={names}
                online={interactive}
              />
            )}
            {read.kind === "withheld" ? (
              <div role="status" className="flex-1 p-8 text-ui text-muted">
                {t("chat.historyAccessCheck")}
              </div>
            ) : (
              // The jump control floats inside this box, over the transcript's
              // bottom edge, so its presence never changes the timeline's height.
              <div
                className={`relative flex min-h-0 flex-1 flex-col transition-opacity duration-150 ${search.receded ? "opacity-50" : ""}`}
                inert={search.receded || undefined}
              >
                <TimelineView
                  owner={resource.owner}
                  messages={read.data.messages}
                  names={names}
                  userId={user.userId}
                  canDeleteOthers={
                    resource.owner.kind === "server" &&
                    (resource.role === "owner" || resource.role === "moderator")
                  }
                  online={interactive}
                  markRead={timeline.markRead}
                  unreadAfter={timeline.entryReadSequence ?? undefined}
                  mode={read.data.mode}
                  destination={timeline.destination}
                  positionChanged={timeline.positionChanged}
                  intro={{
                    kind:
                      resource.owner.kind === "server"
                        ? "room"
                        : "conversation",
                    name: title,
                  }}
                  loadEarlier={
                    read.data.nextBefore != null
                      ? {
                          pending:
                            timeline.history.isPending &&
                            timeline.history.variables === "older",
                          disabled: !interactive || timeline.history.isPending,
                          load: () => timeline.history.mutate("older"),
                        }
                      : undefined
                  }
                  loadNewer={
                    read.data.nextAfter != null
                      ? {
                          pending:
                            timeline.history.isPending &&
                            timeline.history.variables === "newer",
                          disabled: !interactive || timeline.history.isPending,
                          load: () => timeline.history.mutate("newer"),
                        }
                      : undefined
                  }
                  reply={(message: Message) => {
                    void drafts
                      .reply(draftTarget, selectQuote(resource.owner, message))
                      .catch(() => {});
                  }}
                  {...(!forwardSelection
                    ? {
                        forward: (message: Message) =>
                          setForwardSelection(
                            selectQuote(resource.owner, message),
                          ),
                      }
                    : {})}
                  command={(value) => timeline.command.mutateAsync(value)}
                />
                <TimelineJump
                  visible={read.data.mode !== "following"}
                  newer={hasNewerMessages(read.data)}
                  pending={
                    timeline.history.isPending &&
                    timeline.history.variables === "latest"
                  }
                  disabled={!interactive || timeline.history.isPending}
                  error={timeline.history.error}
                  onJump={() => timeline.history.mutate("latest")}
                />
              </div>
            )}
            <DraftComposer
              target={draftTarget}
              typing={
                typingNames.length
                  ? t("chat.typing", {
                      names: new Intl.ListFormat(language, {
                        style: "long",
                        type: "conjunction",
                      }).format(typingNames),
                      count: typingNames.length,
                    })
                  : ""
              }
              onTyping={() => timeline.sendTyping()}
              online={interactive}
              canSend={directPolicy.data?.canSend !== false}
              send={(body) =>
                timeline.command.mutateAsync({ operation: "send", body })
              }
            />
          </>
        );
      }
    }
  }
  return (
    <MessageWorkProvider key={view.kind === "denied" ? "denied" : "allowed"}>
      {view.kind === "conversation" && (
        <SkipLink href="#composer-input">
          {t("workspace.skipToComposer")}
        </SkipLink>
      )}
      <section className="flex h-full min-h-0 flex-col" aria-label={title}>
        <RoomHeader
          navigation={
            <NavigationToggle
              action="open"
              label={t("chat.openConversations")}
              onClick={onNavigation}
            />
          }
          mark={
            resource.owner.kind === "server"
              ? "text"
              : {
                  name: resource.name,
                  hue: personHue(
                    conversationCounterparts(resource, user.userId)[0] ??
                      resource.owner.id,
                  ),
                }
          }
          title={title}
          subtitle={
            resource.owner.kind === "server"
              ? channel?.topic
                ? `${resource.name} · ${channel.topic}`
                : resource.name
              : t("chat.directConversation")
          }
          subtitleTitle={channel?.topic ?? undefined}
        >
          {interactive ? (
            <>
              <RoomNotificationControl
                owner={resource.owner}
                roomId={channelId}
              />
              {resource.owner.kind === "server" && (
                <PresenceStrip resource={resource} />
              )}
              {resource.owner.kind === "conversation" && (
                <DirectBlockControl
                  conversationId={resource.owner.id}
                  name={resource.name}
                />
              )}
              {resource.owner.kind === "conversation" && (
                <JoinCallButton
                  room={{ owner: resource.owner, channelId }}
                  label={resource.name}
                />
              )}
              {resource.owner.kind === "server" && resource.canCreateInvite && (
                <DialogButton
                  label={
                    <>
                      <UserPlus className="size-4" aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only">
                        {t("chat.invite")}
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
              <ConversationSearchControl search={search} />
            </>
          ) : undefined}
        </RoomHeader>
        {forwardSelection && (
          <ForwardPicker
            quote={forwardSelection}
            online={interactive}
            close={() => setForwardSelection(null)}
          />
        )}
        {resource.owner.kind === "conversation" && (
          <DirectCallPanel
            room={{ owner: resource.owner, channelId }}
            title={resource.name}
          />
        )}
        {interactive && timeline.connection === "reconnecting" && (
          <StatusStrip
            action={
              <button
                className={textButtonStyles({ size: "small" })}
                onClick={timeline.reconcile}
              >
                {t("common.tryAgain")}
              </button>
            }
          >
            {t("chat.reconnecting")}
          </StatusStrip>
        )}
        {renderContent()}
      </section>
    </MessageWorkProvider>
  );
}
/** The timeline boundary supplies a complete refresh outcome and its recovery. */
function SnapshotRefreshNotice({
  state,
}: {
  state: ConversationRead["interaction"];
}) {
  const { t, text } = useI18n();
  switch (state.kind) {
    case "ready":
    case "offline":
      return null;
    case "checking":
      return <StatusStrip>{t("chat.checkingAccess")}</StatusStrip>;
    case "failed":
      return (
        <StatusStrip
          action={
            <button
              className={textButtonStyles({ size: "small" })}
              onClick={() => void state.retry()}
            >
              {t("common.tryAgain")}
            </button>
          }
        >
          {text(errorMessage(state.error))}
        </StatusStrip>
      );
  }
}
