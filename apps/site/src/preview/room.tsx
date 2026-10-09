import type { ReactNode } from "react";
import {
  Bell,
  Ellipsis,
  Headphones,
  Mic,
  PhoneCall,
  Plus,
  ScreenShare,
  Search,
  Settings2,
  Smile,
  UserPlus,
  VideoOff,
} from "lucide-react";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import {
  LeaveButton,
  ParticipantChip,
  ParticipantList,
  PipToggle,
  ScreenChip,
  ScreenChips,
  Stage as StageView,
  StageBody,
  StageControls,
  StageHeader,
  StageScreen,
  Toggle,
} from "@vaskel/ui/components/call";
import { NavigationToggle } from "@vaskel/ui/components/home";
import { createFormatters } from "@vaskel/ui/language";
import {
  ComposerNotice,
  MessageRow,
  messageBodyStyles,
  PresenceStrip,
  QuoteAction,
  QuoteBlock,
  quoteBodyStyles,
  ReactionBar,
  ReactionPill,
  RoomHeader,
  SendButton,
  TimelineDivider,
  type MessageTime,
  composerBoxStyles,
  composerFrameStyles,
  composerInputStyles,
  composerToolbarStyles,
} from "@vaskel/ui/components/room";
import { still } from "./stand-ins";
import {
  call,
  circle,
  grouped,
  online,
  people,
  type Message,
  type PersonKey,
  type Room,
} from "./fixture";
import { t, today, type Language } from "./strings";
import { Terminal } from "./terminal";

const time = (language: Language, at: string): MessageTime => {
  const format = createFormatters(language);
  return {
    text: format.formatTime(at),
    dateTime: new Date(at).toISOString(),
    title: format.formatDateTime(at),
  };
};

/** A control the app offers here that the preview only shows. */
function Shown({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span className={className} inert>
      {children}
    </span>
  );
}

/** A header tool: its icon, and its name once the header has room. */
function Tool({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <Shown
      className={buttonStyles({
        variant: "quiet",
        size: "small",
        className: "max-sm:px-2",
      })}
    >
      {icon}
      <span className="sr-only sm:not-sr-only">{label}</span>
    </Shown>
  );
}

/** One message, as the timeline draws it; the preview's bodies are plain text. */
function Row({
  language,
  message,
  previous,
  divider,
  entering,
}: {
  language: Language;
  message: Message;
  previous: Message | undefined;
  divider?: ReactNode;
  entering?: boolean | undefined;
}) {
  const author = people[message.author];
  return (
    <MessageRow
      author={author}
      time={time(language, message.at)}
      grouped={grouped(previous, message)}
      divider={divider}
      className={entering ? "msg-enter" : ""}
    >
      {message.quote && (
        <QuoteBlock
          label={t(language, "chat.quotedReply")}
          author={people[message.quote.author].name}
          time={time(language, message.quote.at)}
          action={
            <QuoteAction inert>{t(language, "chat.openOriginal")}</QuoteAction>
          }
        >
          <p className={quoteBodyStyles()}>{message.quote.body}</p>
        </QuoteBlock>
      )}
      <div className={messageBodyStyles}>{message.body}</div>
      {message.reactions && (
        <ReactionBar inert>
          {message.reactions.map((reaction) => (
            <ReactionPill
              key={reaction.emoji}
              emoji={reaction.emoji}
              count={String(reaction.count)}
              mine={Boolean(reaction.mine)}
            />
          ))}
        </ReactionBar>
      )}
    </MessageRow>
  );
}

/** The composer at rest; someone typing takes the status slot, as in the app. */
function Composer({
  language,
  label,
  typing,
}: {
  language: Language;
  label: string;
  typing: string;
}) {
  return (
    <div className={composerFrameStyles}>
      <div className={composerBoxStyles}>
        <div className={composerInputStyles}>
          <span className="text-muted opacity-90">
            {t(language, "chat.messageTo", { label })}
          </span>
        </div>
        <div className={composerToolbarStyles}>
          <Shown className={buttonStyles({ variant: "muted", size: "icon" })}>
            <Plus aria-hidden="true" />
          </Shown>
          {typing ? (
            <ComposerNotice text={typing} />
          ) : (
            <ComposerNotice text={t(language, "chat.composerShortcut")} hint />
          )}
          <Shown className={buttonStyles({ variant: "muted", size: "icon" })}>
            <Smile aria-hidden="true" />
          </Shown>
          <SendButton type="button" label={t(language, "chat.send")} disabled />
        </div>
      </div>
    </div>
  );
}

type TextRoomProps = {
  language: Language;
  room: Exclude<Room, "lounge">;
  messages: Message[];
  unreadFrom?: string | undefined;
  entering?: Set<string>;
  typing?: PersonKey | null;
  openNavigation: () => void;
};

/** A text room or direct message: header, transcript and composer. */
export function TextRoom({
  language,
  room,
  messages,
  unreadFrom,
  entering,
  typing,
  openNavigation,
}: TextRoomProps) {
  const direct = room === "shirasu";
  const topic =
    room === "general"
      ? "the group chat"
      : room === "memes"
        ? "no context, no mercy"
        : undefined;
  return (
    <>
      <RoomHeader
        navigation={
          <NavigationToggle
            action="open"
            label={t(language, "chat.openConversations")}
            onClick={openNavigation}
          />
        }
        mark={direct ? people.shirasu : "text"}
        title={direct ? people.shirasu.name : room}
        subtitle={
          direct
            ? t(language, "chat.directConversation")
            : `${circle.name} · ${topic}`
        }
        subtitleTitle={topic}
      >
        <Shown
          className={buttonStyles({
            variant: "quiet",
            size: "icon",
          })}
        >
          <Bell className="size-4" aria-hidden="true" />
        </Shown>
        {direct ? (
          <>
            <Tool
              icon={<Ellipsis className="size-4" aria-hidden="true" />}
              label={t(language, "blocking.options")}
            />
            <Shown
              className={buttonStyles({
                variant: "primary",
                size: "small",
                shape: "round",
              })}
            >
              <PhoneCall className="size-4" aria-hidden="true" />
              {t(language, "media.joinCall")}
            </Shown>
          </>
        ) : (
          <>
            <PresenceStrip
              render={still}
              people={online.map((key) => people[key])}
              label={t(language, "workspace.onlineCount", {
                count: online.length,
              })}
            />
            <Tool
              icon={<UserPlus className="size-4" aria-hidden="true" />}
              label={t(language, "chat.invite")}
            />
            <Tool
              icon={<Search className="size-4" aria-hidden="true" />}
              label={t(language, "chat.search")}
            />
          </>
        )}
      </RoomHeader>
      <div className="timeline flex min-h-0 flex-1 flex-col justify-end overflow-hidden pt-2 pb-1">
        {messages.map((message, index) => (
          <Row
            key={message.at + message.author}
            language={language}
            message={message}
            previous={
              unreadFrom === message.at ? undefined : messages[index - 1]
            }
            divider={
              index === 0 || unreadFrom === message.at ? (
                <TimelineDivider
                  day={index === 0 ? today(language) : undefined}
                  unread={
                    unreadFrom === message.at
                      ? t(language, "activity.unread")
                      : undefined
                  }
                />
              ) : undefined
            }
            entering={entering?.has(message.at)}
          />
        ))}
      </div>
      <Composer
        language={language}
        label={direct ? people.shirasu.name : `#${room}`}
        typing={
          typing
            ? t(language, "chat.typing", { names: people[typing].name })
            : ""
        }
      />
    </>
  );
}

/** The voice room: its stage fills the pane while the viewer is in it. */
export function Stage({
  language,
  openNavigation,
  leaveStage,
}: {
  language: Language;
  openNavigation: () => void;
  leaveStage: () => void;
}) {
  return (
    <>
      <RoomHeader
        navigation={
          <NavigationToggle
            action="open"
            label={t(language, "chat.openConversations")}
            onClick={openNavigation}
          />
        }
        mark="media"
        title={call.room}
        subtitle={t(language, "media.voiceChannelName", { name: circle.name })}
      />
      <StageView>
        <StageHeader
          phase="active"
          title={call.room}
          context={circle.name}
          status={t(language, "media.participantCount", {
            count: call.participants.length,
          })}
          duration={call.duration}
        >
          <PipToggle
            label={t(language, "media.pictureInPicture")}
            aria-pressed={false}
            onClick={leaveStage}
          />
        </StageHeader>
        <StageBody>
          <ScreenChips label={t(language, "media.screens")}>
            <ScreenChip selected inert>
              {people[call.sharer].name}
            </ScreenChip>
          </ScreenChips>
          <StageScreen>
            <div className="share big">
              <Terminal />
            </div>
          </StageScreen>
          <ParticipantList label={t(language, "media.atTheTable")}>
            {call.participants.map((key) => {
              const speaking = key === call.sharer;
              const muted = call.muted.includes(key);
              return (
                <ParticipantChip
                  key={key}
                  name={
                    key === "wren"
                      ? t(language, "media.yourName", {
                          name: people.wren.name,
                        })
                      : people[key].name
                  }
                  hue={people[key].hue}
                  speaking={speaking}
                  muted={muted}
                  status={t(
                    language,
                    muted
                      ? "media.mutedByOwner"
                      : speaking
                        ? "media.speaking"
                        : "media.inCall",
                  )}
                />
              );
            })}
          </ParticipantList>
        </StageBody>
        <StageControls inert>
          <Toggle
            state="on"
            label={t(language, "media.mute")}
            icon={<Mic className="size-5" aria-hidden="true" />}
          />
          <Toggle
            state="idle"
            label={t(language, "media.camera")}
            icon={<VideoOff className="size-5" aria-hidden="true" />}
          />
          <Toggle
            state="idle"
            label={t(language, "media.shareScreen")}
            icon={<ScreenShare className="size-5" aria-hidden="true" />}
          />
          <Toggle
            state="idle"
            label={t(language, "media.deafenSelf")}
            icon={<Headphones className="size-5" aria-hidden="true" />}
          />
          <Toggle
            state="idle"
            label={t(language, "media.devices")}
            icon={<Settings2 className="size-5" aria-hidden="true" />}
          />
          <LeaveButton label={t(language, "media.leave")} />
        </StageControls>
      </StageView>
    </>
  );
}
