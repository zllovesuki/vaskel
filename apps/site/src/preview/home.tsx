import { Ellipsis, Plus } from "lucide-react";
import { Avatar } from "@vaskel/ui/components/avatar";
import {
  buttonStyles,
  sidebarBodyStyles,
  workspaceSidebarStyles,
} from "@vaskel/ui/components/control-styles";
import {
  ChannelRow,
  CircleHeader,
  DirectRow,
  HomeHeader,
  HomeSection,
  InboxRow,
  LiveCallCard,
  NavigationToggle,
  PeopleRow,
  SearchRow,
  UnreadMark,
  Wordmark,
} from "@vaskel/ui/components/home";
import { CallDock } from "./chrome";
import { opens, still } from "./stand-ins";
import { call, circle, online, people, type Room } from "./fixture";
import { t, type Language } from "./strings";

type Props = {
  language: Language;
  room: Room;
  unread: Set<Room>;
  go: (room: Room) => void;
  closeNavigation: () => void;
  /** The dock renders only while the call's stage is off screen. */
  showDock: boolean;
};

/** Home, drawn with the app's own parts: nothing here restyles them. */
export function Home({
  language,
  room,
  unread,
  go,
  closeNavigation,
  showDock,
}: Props) {
  const inbox = (["memes"] as const).filter((target) => unread.has(target));
  return (
    <aside className={`ws-side ${workspaceSidebarStyles}`} aria-label="Home">
      <HomeHeader
        wordmark={
          <Wordmark
            render={(props) => <span {...props} aria-hidden="true" />}
          />
        }
        close={
          <NavigationToggle
            action="close"
            label={t(language, "workspace.closeConversations")}
            onClick={closeNavigation}
          />
        }
        add={
          <span
            className={buttonStyles({ variant: "quiet", size: "icon" })}
            inert
          >
            <Plus aria-hidden="true" />
          </span>
        }
        account={
          <span
            className={buttonStyles({
              variant: "quiet",
              size: "icon",
              shape: "round",
            })}
            inert
          >
            <Avatar name={people.wren.name} hue={people.wren.hue} size={8} />
          </span>
        }
      />
      <div className={sidebarBodyStyles}>
        <SearchRow render={still} label={t(language, "search.title")} />
        <HomeSection
          className="mb-4"
          aria-label={t(language, "workspace.happeningNow")}
          label={t(language, "workspace.happeningNow")}
        >
          <div className="flex flex-col gap-1.5">
            <LiveCallCard
              render={opens(() => go("lounge"))}
              people={call.participants.slice(0, 3).map((key) => people[key])}
              more={String(call.participants.length - 3)}
              room={call.room}
              place={circle.name}
              inCall={t(language, "workspace.inTheCall", {
                count: call.participants.length,
              })}
              duration={call.duration}
              sharing={t(language, "workspace.isSharing", {
                name: people[call.sharer].name,
              })}
              youAreIn={t(language, "workspace.youAreIn")}
            />
          </div>
        </HomeSection>
        {inbox.length > 0 && (
          <HomeSection
            className="mb-4 text-caption text-muted"
            aria-label={t(language, "activity.unread")}
            label={t(language, "activity.unread")}
          >
            {inbox.map((target) => (
              <InboxRow
                key={target}
                render={opens(() => go(target))}
                name={target}
                place={circle.name}
              >
                <UnreadMark
                  kind="badge"
                  text="2"
                  label={t(language, "workspace.unreadCount", { count: 2 })}
                />
              </InboxRow>
            ))}
          </HomeSection>
        )}
        <HomeSection
          className="not-first:mt-4"
          label={t(language, "workspace.servers")}
          count="1"
        >
          <section className="not-first:mt-3">
            <CircleHeader
              toggle={still}
              name={circle.name}
              initial={circle.initial}
              expanded
            >
              <span
                className={buttonStyles({
                  variant: "muted",
                  size: "icon-small",
                })}
                inert
              >
                <Ellipsis className="size-4" aria-hidden="true" />
              </span>
            </CircleHeader>
            <nav aria-label={`${circle.name} rooms`}>
              <PeopleRow
                render={still}
                label={t(language, "workspace.people")}
                detail={t(language, "workspace.onlineCount", {
                  count: online.length,
                })}
              />
              <ChannelRow
                render={opens(() => go("general"))}
                kind="text"
                name="general"
                current={room === "general"}
              />
              <ChannelRow
                render={opens(() => go("memes"))}
                kind="text"
                name="memes"
                current={room === "memes"}
                unread={unread.has("memes")}
              >
                {unread.has("memes") && (
                  <UnreadMark
                    kind="dot"
                    label={t(language, "activity.unread")}
                  />
                )}
              </ChannelRow>
              <ChannelRow
                render={opens(() => go("lounge"))}
                kind="media"
                name={call.room}
                current={room === "lounge"}
              >
                <span className="sr-only">
                  {t(language, "workspace.voiceChannel")}
                </span>
              </ChannelRow>
            </nav>
          </section>
        </HomeSection>
        <HomeSection
          className="not-first:mt-4"
          label={t(language, "workspace.directMessages")}
          action={
            <span
              className={buttonStyles({ variant: "muted", size: "icon-small" })}
              inert
            >
              <Plus className="size-4" aria-hidden="true" />
            </span>
          }
        >
          <nav aria-label={t(language, "workspace.directMessages")}>
            <DirectRow
              render={opens(() => go("shirasu"))}
              name={people.shirasu.name}
              hue={people.shirasu.hue}
              current={room === "shirasu"}
              unread={unread.has("shirasu")}
            >
              {unread.has("shirasu") && (
                <UnreadMark kind="dot" label={t(language, "activity.unread")} />
              )}
            </DirectRow>
          </nav>
        </HomeSection>
      </div>
      {showDock && <CallDock language={language} go={go} />}
    </aside>
  );
}
