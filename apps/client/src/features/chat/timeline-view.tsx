import { useTimelineKeyboard } from "./use-timeline-keyboard";
import { VisibleReadObserver } from "./visible-read-observer";
import { PendingLabel } from "@/client/ui/loading-skeleton";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Hash, MessageCircle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  elementScroll,
  observeElementOffset,
  useVirtualizer,
} from "@tanstack/react-virtual";
import type { Message, OwnerScope } from "@vaskel/contracts/messaging";
import { MessageRow } from "@/client/features/chat/message-row";
import type {
  TimelineCommand,
  TimelineMode,
} from "@/client/features/chat/reconcile";
import type { TimelineDestination } from "./timeline-navigation";
import {
  timelineIntroPlacement,
  type HistoryPaging,
  type TimelineIntro,
} from "@/client/features/chat/timeline-surface";
import { textButtonStyles } from "@vaskel/ui/components/control-styles";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";
import { TimelineDivider } from "@vaskel/ui/components/room";

/** Consecutive messages from one author within this window share a header. */
const GROUP_WINDOW = 5 * 60_000;
/** The floating jump control's height plus its inset from the bottom edge. */
const JUMP_CLEARANCE = 56;
/** A row's height before measurement; the opening offset counts from it. */
const ROW_ESTIMATE = 72;

function dayKey(value: number) {
  const date = new Date(value);
  return (
    date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate()
  );
}

export function TimelineView({
  messages,
  owner,
  names,
  userId,
  canDeleteOthers = false,
  online = false,
  markRead,
  command,
  reply,
  forward,
  unreadAfter,
  mode = "following",
  destination,
  positionChanged,
  loadEarlier,
  loadNewer,
  intro,
}: {
  messages: Message[];
  owner: OwnerScope;
  names: Map<string, string>;
  userId?: string;
  canDeleteOthers?: boolean;
  online?: boolean;
  reply?: (message: Message) => void;
  forward?: (message: Message) => void;
  markRead?: (sequence: number) => void;
  /** Read position when the channel opened; later messages get an unread marker. */
  unreadAfter?: number | undefined;
  mode?: TimelineMode;
  /** Accepted navigation requests alignment independently of the reading mode. */
  destination?: TimelineDestination | undefined;
  positionChanged?: (atBottom: boolean, visibleSequence?: number) => void;
  loadEarlier?: HistoryPaging | undefined;
  /** Present only while a jump holds a range short of the latest messages. */
  loadNewer?: HistoryPaging | undefined;
  /** Names this room or conversation for the start-of-history intro. */
  intro?: TimelineIntro | undefined;
  command?: (value: TimelineCommand) => Promise<unknown>;
}) {
  "use no memo"; // TanStack Virtual exposes a mutable instance; keep its measurements live.
  const { t, language, formatDate } = useI18n();
  const relative = useMemo(
    () => new Intl.RelativeTimeFormat(language, { numeric: "auto" }),
    [language],
  );
  const scroll = useRef<HTMLDivElement>(null);
  const reportOffset = useRef<
    ((offset: number, scrolling: boolean) => void) | null
  >(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const placement = timelineIntroPlacement({
    intro,
    loadEarlier,
    messageCount: messages.length,
  });
  const listRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const viewport = element.closest<HTMLElement>("[data-message-count]")!;
      // Row offsets start inside the list, after the intro and any alignment
      // space. Virtual needs that origin in the scroll viewport's coordinates.
      const measure = () =>
        setScrollMargin(
          element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop,
        );
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      observer.observe(element);
      if (placement === "leading" && element.previousElementSibling)
        observer.observe(element.previousElementSibling);
      return () => observer.disconnect();
    },
    [placement],
  );
  const positioned = useRef<"initial" | number | null>(null);
  const focused = useRef<number | null>(null);
  // Highlight expiry changes presentation only; it never consumes a navigation.
  const [expiredHighlight, setExpiredHighlight] = useState<number | null>(null);
  const highlightedSequence =
    destination?.kind === "message" && destination.revision !== expiredHighlight
      ? destination.sequence
      : undefined;
  useEffect(() => {
    if (destination?.kind !== "message") return;
    const timer = setTimeout(
      () => setExpiredHighlight(destination.revision),
      2_000,
    );
    return () => clearTimeout(timer);
  }, [destination]);
  const boundary = useRef<{
    sequence: number;
    inset: number;
    visible: boolean;
  } | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- This component opts out with "use no memo" and consumes the mutable virtualizer locally.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroll.current,
    observeElementOffset: (instance, report) => {
      reportOffset.current = report;
      const unsubscribe = observeElementOffset(instance, report);
      return () => {
        reportOffset.current = null;
        unsubscribe?.();
      };
    },
    scrollToFn: (offset, options, instance) => {
      elementScroll(offset, options, instance);
      // Instant commands have already moved the viewport. Report that position
      // before a later render can replay an adjustment from the previous view.
      if (
        options.behavior !== undefined &&
        options.behavior !== "smooth" &&
        instance.scrollElement
      )
        reportOffset.current?.(instance.scrollElement.scrollTop, false);
    },
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: 8,
    paddingStart: loadEarlier ? 40 : 0,
    // The newer-page control sits above the zone the floating jump control
    // occupies, so a held range's last row and its paging both stay reachable.
    paddingEnd: loadNewer ? 40 + JUMP_CLEARANCE : 0,
    anchorTo: "end",
    followOnAppend: mode === "following",
    scrollEndThreshold: 100,
    scrollMargin,
    // Mount the latest rows first while following. The opening scroll below
    // aligns the real end as the viewport and rows are measured.
    initialOffset: mode === "following" ? messages.length * ROW_ESTIMATE : 0,
  });
  const total = virtualizer.getTotalSize();
  function captureBoundary() {
    const element = scroll.current;
    const wrapper = element?.querySelector<HTMLElement>('[data-index="0"]');
    const article = wrapper?.querySelector("article");
    if (!element || !wrapper || !article) return null;
    const content = article.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();
    return {
      sequence: Number(wrapper.dataset.timelineSequence),
      inset: content.top - wrapper.getBoundingClientRect().top,
      visible: content.bottom > viewport.top && content.top < viewport.bottom,
    };
  }
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !messages.length) return;
    if (destination && destination.revision !== positioned.current) {
      if (destination.kind === "latest") virtualizer.scrollToEnd();
      else {
        const index = messages.findIndex(
          (message) => message.createdSequence === destination.sequence,
        );
        if (index < 0) return;
        virtualizer.scrollToIndex(index, { align: "center" });
      }
      positioned.current = destination.revision;
    } else if (positioned.current === null) {
      virtualizer.scrollToEnd();
      positioned.current = "initial";
    } else if (
      mode !== "following" &&
      boundary.current?.visible &&
      boundary.current.sequence !== messages[0]!.createdSequence
    ) {
      // Virtual anchors the row wrapper. A prepended predecessor can remove
      // this row's day/unread decorations; preserve the article within it too.
      const previous = boundary.current;
      const wrapper = element.querySelector<HTMLElement>(
        `[data-timeline-sequence="${previous.sequence}"]`,
      );
      const article = wrapper?.querySelector("article");
      if (wrapper && article) {
        const inset =
          article.getBoundingClientRect().top -
          wrapper.getBoundingClientRect().top;
        virtualizer.scrollToOffset(element.scrollTop + inset - previous.inset);
      }
    }
    boundary.current = captureBoundary();
    // Virtual retains measured sizes by key; discarded rows need no future
    // measurement history. Keep that metadata bounded with the Query window.
    const retained = new Set(messages.map((message) => message.id));
    for (const key of virtualizer.itemSizeCache.keys())
      if (!retained.has(String(key))) virtualizer.itemSizeCache.delete(key);
  }, [messages, mode, destination, virtualizer]);
  // The application chooses a target; Virtual alone reconciles row measurements.
  // Viewport resizing requests the end once, only while following. Leaving that
  // mode disconnects the observer in the same layout phase as a history jump.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || mode !== "following") return;
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = element.clientHeight;
      if (next === height) return;
      height = next;
      if (virtualizer.options.count > 0) virtualizer.scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, virtualizer]);
  const hintId = useId();
  const keyboard = useTimelineKeyboard(messages, scroll, (index) =>
    virtualizer.scrollToIndex(index, { align: "center" }),
  );
  const { activeId } = keyboard;
  const items = virtualizer.getVirtualItems();
  const visibleIds = items.map((item) => item.key).join(",");
  useLayoutEffect(() => {
    if (
      destination?.kind !== "message" ||
      destination.revision === focused.current
    )
      return;
    // Measurement can take more than one frame to mount the target. Focus
    // follows that mount once per navigation, independently of scroll settling.
    const article = scroll.current?.querySelector<HTMLElement>(
      `[data-timeline-sequence="${destination.sequence}"] article`,
    );
    if (!article) return;
    article.focus({ preventScroll: true });
    focused.current = destination.revision;
  }, [destination, visibleIds]);
  const activeMounted =
    activeId !== undefined &&
    items.some((item) => messages[item.index]?.id === activeId);
  const now = Date.now();
  const today = dayKey(now);
  const previousDay = new Date(now);
  previousDay.setDate(previousDay.getDate() - 1);
  const yesterday = dayKey(previousDay.getTime());
  return (
    <div
      className="min-h-0 flex-1 overflow-auto overscroll-contain pt-2 pb-3 [overflow-anchor:none]"
      ref={scroll}
      tabIndex={activeMounted ? -1 : 0}
      aria-label={t("chat.messages")}
      aria-describedby={hintId}
      data-message-count={messages.length}
      onPointerDown={keyboard.onPointerDown}
      onPointerUp={keyboard.onPointerUp}
      onPointerCancel={keyboard.onPointerCancel}
      onFocus={keyboard.onFocus}
      onKeyDown={keyboard.onKeyDown}
      onScroll={() => {
        const element = scroll.current;
        if (element) {
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            100;
          const item = virtualizer.getVirtualItemForOffset(element.scrollTop);
          boundary.current = captureBoundary();
          positionChanged?.(
            atBottom,
            item ? messages[item.index]?.createdSequence : undefined,
          );
        }
      }}
    >
      <span id={hintId} className="sr-only">
        {t("chat.messagesKeyboardHint")}
      </span>
      {online && markRead && unreadAfter !== undefined && (
        <VisibleReadObserver
          scroll={scroll}
          visibleIds={visibleIds}
          markRead={markRead}
        />
      )}
      {messages.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-page-gutter py-16 text-center">
          {placement === "empty" && intro ? (
            <TimelineIntroContent intro={intro} ownerId={owner.id} />
          ) : (
            <>
              <span
                className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent"
                aria-hidden="true"
              >
                <MessageCircle className="size-6" />
              </span>
              <h2 className="text-lg">{t("chat.noMessagesYet")}</h2>
            </>
          )}
          <p className="max-w-[40ch] text-ui text-muted">
            {online ? t("chat.emptyOnline") : t("chat.emptyOffline")}
          </p>
        </div>
      ) : (
        <div className="flex min-h-full flex-col justify-end">
          {placement === "leading" && intro && (
            <div className="flex flex-col items-start gap-2 px-page-gutter pt-6 pb-3">
              <TimelineIntroContent intro={intro} ownerId={owner.id} />
            </div>
          )}
          <div
            ref={listRef}
            className="relative w-full"
            style={{ height: total }}
          >
            {loadEarlier && (
              <div className="absolute inset-x-0 top-0 flex h-10 items-center justify-center">
                <button
                  className={textButtonStyles({ size: "small" })}
                  disabled={loadEarlier.pending || loadEarlier.disabled}
                  aria-busy={loadEarlier.pending}
                  onClick={() => {
                    // Scrolling can notify before Virtual mounts the first row.
                    // Capture the settled DOM at the actual paging action too.
                    boundary.current = captureBoundary();
                    loadEarlier.load();
                  }}
                >
                  <PendingLabel
                    pending={loadEarlier.pending}
                    label={t("chat.loading")}
                  >
                    {t("chat.loadEarlierMessages")}
                  </PendingLabel>
                </button>
              </div>
            )}
            {items.map((item) => {
              const message = messages[item.index]!;
              const previous =
                item.index > 0 ? messages[item.index - 1] : undefined;
              const day = dayKey(message.createdAt);
              const dayChanged =
                !previous || dayKey(previous.createdAt) !== day;
              const fresh =
                unreadAfter !== undefined &&
                message.createdSequence > unreadAfter &&
                (previous === undefined ||
                  previous.createdSequence <= unreadAfter);
              const grouped =
                previous !== undefined &&
                !dayChanged &&
                !fresh &&
                previous.authorId === message.authorId &&
                message.createdAt - previous.createdAt < GROUP_WINDOW;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  data-timeline-sequence={message.createdSequence}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 w-full"
                  style={{
                    transform: `translateY(${item.start - scrollMargin}px)`,
                  }}
                >
                  <MessageRow
                    message={message}
                    owner={owner}
                    name={names.get(message.authorId) ?? t("chat.member")}
                    own={message.authorId === userId}
                    canDeleteOthers={canDeleteOthers}
                    online={online}
                    command={command}
                    names={names}
                    reply={reply}
                    forward={forward}
                    mentioned={
                      userId !== undefined && message.mentions.includes(userId)
                    }
                    jumped={message.createdSequence === highlightedSequence}
                    active={message.id === activeId}
                    grouped={grouped}
                    divider={
                      dayChanged || fresh ? (
                        <TimelineDivider
                          day={
                            !dayChanged
                              ? undefined
                              : day === today
                                ? relative.format(0, "day")
                                : day === yesterday
                                  ? relative.format(-1, "day")
                                  : formatDate(message.createdAt)
                          }
                          unread={fresh ? t("activity.unread") : undefined}
                        />
                      ) : undefined
                    }
                  />
                </div>
              );
            })}
            {loadNewer && (
              // The mirror of the earlier-history control: a held range ends
              // here until paging forward reaches the latest messages.
              <div
                className="absolute inset-x-0 flex h-10 items-center justify-center"
                style={{ bottom: JUMP_CLEARANCE }}
              >
                <button
                  className={textButtonStyles({ size: "small" })}
                  disabled={loadNewer.pending || loadNewer.disabled}
                  aria-busy={loadNewer.pending}
                  onClick={() => {
                    boundary.current = captureBoundary();
                    loadNewer.load();
                  }}
                >
                  <PendingLabel
                    pending={loadNewer.pending}
                    label={t("chat.loading")}
                  >
                    {t("chat.loadNewerMessages")}
                  </PendingLabel>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The start of a history: a tinted tile, the place's name and what it is. */
function TimelineIntroContent({
  intro,
  ownerId,
}: {
  intro: TimelineIntro;
  ownerId: string;
}) {
  const { t } = useI18n();
  return (
    <>
      <Avatar name={intro.name} hue={personHue(ownerId)} size={12}>
        {intro.kind === "room" ? <Hash className="size-6" /> : undefined}
      </Avatar>
      <h2 className="text-lg wrap-anywhere">
        {intro.kind === "room"
          ? t("chat.roomIntroTitle", { name: intro.name })
          : t("chat.conversationIntroTitle", { name: intro.name })}
      </h2>
      {intro.kind === "room" && (
        <p className="max-w-[40ch] text-ui text-muted">
          {t("chat.roomIntroBody")}
        </p>
      )}
    </>
  );
}
