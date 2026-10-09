import type {
  DeleteMessage,
  EditMessage,
  Message,
  MessageEvent,
  MessagingOutcome,
  ReactMessage,
  Receipt,
  RemoveMessageAttachment,
  ReplayCursor,
  SendMessage,
} from "@vaskel/contracts/messaging";

/** Resident online rows; independent of the persisted history policy. */
export const TIMELINE_MESSAGE_LIMIT = 200;
export type TimelineSnapshot = Extract<MessagingOutcome, { kind: "snapshot" }>;
/** A window centred on one message, for opening a link or a search result. */
export type TimelineAround = Extract<MessagingOutcome, { kind: "around" }>;
/** Every command the timeline sends for a message; one receipt path serves all. */
export type TimelineCommand =
  | { operation: "send"; body: SendMessage }
  | { operation: "edit"; body: EditMessage }
  | { operation: "delete"; body: DeleteMessage }
  | { operation: "remove-attachment"; body: RemoveMessageAttachment }
  | { operation: "react"; body: ReactMessage };
export type TimelineOperation = TimelineCommand["operation"];
/** Paused latest history may resume at the bottom; an explicit historical range may not. */
export type TimelineMode = "following" | "paused" | "historical";
export interface Timeline {
  messages: Message[];
  cursor: ReplayCursor;
  nextBefore: number | null;
  /** The next message after the window, while a jump holds a historical range. */
  nextAfter: number | null;
  readSequence: number;
  /** Observed creation and mutation positions survive row eviction. */
  lastCreatedSequence: number;
  lastMutationSequence: number;
  mode: TimelineMode;
  /** Invalidates delayed navigation results without changing replay position. */
  windowVersion: number;
}
export function mergeMessages(
  current: Message[],
  incoming: Message[],
  edge: "latest" | "earliest" = "latest",
): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (
      !previous ||
      message.version > previous.version ||
      (message.version === previous.version &&
        message.updatedSequence >= previous.updatedSequence)
    )
      byId.set(message.id, message);
  }
  const ordered = [...byId.values()].sort(
    (a, b) => a.createdSequence - b.createdSequence,
  );
  return edge === "latest"
    ? ordered.slice(-TIMELINE_MESSAGE_LIMIT)
    : ordered.slice(0, TIMELINE_MESSAGE_LIMIT);
}

export function sameStream(a: ReplayCursor, b: ReplayCursor) {
  return (
    a.generation === b.generation &&
    a.channelId === b.channelId &&
    a.owner.kind === b.owner.kind &&
    a.owner.id === b.owner.id
  );
}

export function latestTimeline(
  snapshot: Omit<TimelineSnapshot, "kind">,
  previous?: Timeline,
): Timeline {
  const current =
    previous && sameStream(previous.cursor, snapshot.cursor)
      ? previous
      : undefined;
  return {
    messages: mergeMessages([], snapshot.messages),
    cursor: {
      ...snapshot.cursor,
      sequence: Math.max(
        snapshot.cursor.sequence,
        current?.cursor.sequence ?? 0,
      ),
    },
    nextBefore: snapshot.nextBefore,
    // The authoritative latest window ends at the newest message there is.
    nextAfter: null,
    readSequence: Math.max(snapshot.readSequence, current?.readSequence ?? 0),
    lastCreatedSequence: Math.max(
      current?.lastCreatedSequence ?? 0,
      ...snapshot.messages.map((item) => item.createdSequence),
    ),
    lastMutationSequence: current?.lastMutationSequence ?? 0,
    mode: "following",
    windowVersion: (previous?.windowVersion ?? -1) + 1,
  };
}

export function hasNewerMessages(state: Timeline) {
  return (
    state.lastCreatedSequence > (state.messages.at(-1)?.createdSequence ?? 0)
  );
}

export function followTimeline(state: Timeline, atBottom: boolean): Timeline {
  // A held historical range cannot be spliced directly onto an unseen tail.
  // An already-following view keeps its intent while socket observations are
  // ahead of replay; native scrolling during that interval is not a pause.
  if (state.mode === "historical") return state;
  const mode =
    atBottom && (state.mode === "following" || !hasNewerMessages(state))
      ? "following"
      : "paused";
  return mode === state.mode ? state : { ...state, mode };
}

export function beginTimelineNavigation(state: Timeline): Timeline {
  return {
    ...state,
    mode: state.mode === "following" ? "paused" : state.mode,
    windowVersion: state.windowVersion + 1,
  };
}

/** Receipts fence later snapshots, but never manufacture a second message row. */
export function observeReceipt(
  state: Timeline,
  operation: TimelineOperation,
  receipt: Receipt,
): Timeline {
  return {
    ...state,
    lastCreatedSequence:
      operation === "send"
        ? Math.max(state.lastCreatedSequence, receipt.sequence)
        : state.lastCreatedSequence,
    lastMutationSequence:
      operation !== "send"
        ? Math.max(state.lastMutationSequence, receipt.sequence)
        : state.lastMutationSequence,
  };
}

export function acceptOlderSnapshot(
  state: Timeline,
  snapshot: TimelineSnapshot,
  visibleSequence?: number,
): Timeline | null {
  const messages = mergeMessages(state.messages, snapshot.messages, "earliest");
  // The reader may have scrolled while the page was in flight. Keep their row.
  if (
    visibleSequence &&
    !messages.some((item) => item.createdSequence === visibleSequence)
  )
    return null;
  const tail = messages.at(-1)?.createdSequence;
  // Paging back past the resident limit discards the newest rows, so messages
  // now exist after this window. The forward anchor follows the surviving tail.
  const evicted =
    tail !== undefined && tail < (state.messages.at(-1)?.createdSequence ?? 0);
  return {
    ...state,
    messages,
    nextBefore: snapshot.nextBefore,
    nextAfter: evicted ? tail : state.nextAfter,
    readSequence: Math.max(state.readSequence, snapshot.readSequence),
    mode: state.mode === "historical" || evicted ? "historical" : "paused",
  };
}
/**
 * Where paging forward asks the owner to continue from: the last resident row,
 * which the owner's window includes, so the page returned always overlaps what
 * the reader already holds. Null once the window reaches the newest message.
 */
export function forwardAnchor(state: Timeline): number | null {
  if (state.nextAfter === null) return null;
  return state.messages.at(-1)?.createdSequence ?? state.nextAfter;
}

/**
 * Only the authoritative latest window advances the private read position. A
 * held range — a jump, or any window with messages still to come after it —
 * shows history the reader never scrolled through, and marking that read would
 * silently clear a backlog they have not seen.
 */
export function marksRead(state: Timeline, sequence: number): boolean {
  return (
    state.mode === "following" &&
    state.nextAfter === null &&
    sequence > state.readSequence
  );
}

/**
 * Installs the window a jump fetched. An around window is a historical range,
 * not an authoritative latest snapshot: it never advances the contiguous replay
 * cursor, and the read position, observed creation and observed mutation only
 * ever move forward. The reader is held here until Latest or paging forward
 * reaches the end, so the window does not follow.
 */
export function installAroundWindow(
  state: Timeline,
  around: TimelineAround,
): Timeline | null {
  if (around.messages.length === 0) return null;
  return {
    ...state,
    messages: mergeMessages([], around.messages),
    nextBefore: around.nextBefore,
    nextAfter: around.nextAfter,
    readSequence: Math.max(state.readSequence, around.readSequence),
    lastCreatedSequence: Math.max(
      state.lastCreatedSequence,
      ...around.messages.map((item) => item.createdSequence),
    ),
    mode: "historical",
  };
}

/**
 * Pages one window forward from a held range. The page must reach back to the
 * resident tail as it stands now — not to the anchor the owner last reported,
 * which paging earlier past the resident limit leaves behind — so a forward
 * step can never splice a gap into the transcript. The newest rows are kept and
 * the oldest edge is discarded with `nextBefore` raised to the surviving first
 * row, exactly as an incoming tail trims.
 */
export function acceptNewerWindow(
  state: Timeline,
  around: TimelineAround,
  visibleSequence?: number,
): Timeline | null {
  const tail = forwardAnchor(state);
  const first = around.messages[0]?.createdSequence;
  if (tail === null || first === undefined || first > tail) return null;
  const messages = mergeMessages(state.messages, around.messages);
  // The reader may have scrolled while the page was in flight. Keep their row.
  if (
    visibleSequence &&
    !messages.some((item) => item.createdSequence === visibleSequence)
  )
    return null;
  const trimmed =
    messages[0] !== undefined &&
    messages[0].createdSequence > (state.messages[0]?.createdSequence ?? 0);
  return {
    ...state,
    messages,
    nextBefore: trimmed ? messages[0]!.createdSequence : state.nextBefore,
    nextAfter: around.nextAfter,
    readSequence: Math.max(state.readSequence, around.readSequence),
    lastCreatedSequence: Math.max(
      state.lastCreatedSequence,
      ...around.messages.map((item) => item.createdSequence),
    ),
    mode: around.nextAfter !== null ? "historical" : "paused",
  };
}

export function applyEvents(
  state: Timeline,
  events: MessageEvent[],
  cursor?: ReplayCursor,
): Timeline {
  return reconcileEvents(state, events, cursor, true);
}

/** Socket delivery can skip sends. Only replay inserts new resident rows. */
export function observeEvents(
  state: Timeline,
  events: MessageEvent[],
): Timeline {
  return reconcileEvents(state, events, undefined, false);
}

export function observesMutation(event: MessageEvent) {
  // Replay materializes the current row, even for its earlier send event.
  return event.operation !== "send" || event.message.version > 1;
}

function reconcileEvents(
  state: Timeline,
  events: MessageEvent[],
  cursor: ReplayCursor | undefined,
  insert: boolean,
): Timeline {
  if (cursor && !sameStream(state.cursor, cursor)) return state;
  const resident = new Set(state.messages.map((message) => message.id));
  const first = state.messages[0]?.createdSequence ?? 0;
  const last = state.messages.at(-1)?.createdSequence ?? 0;
  const incoming = events
    .map((event) => event.message)
    .filter(
      (message) =>
        (insert || resident.has(message.id)) &&
        message.createdSequence >= first &&
        (state.mode === "following" || message.createdSequence <= last),
    );
  const messages = mergeMessages(state.messages, incoming);
  const trimmed = messages[0] && messages[0].createdSequence > first;
  return {
    ...state,
    messages,
    nextBefore:
      trimmed &&
      state.messages.length + incoming.length > TIMELINE_MESSAGE_LIMIT
        ? messages[0]!.createdSequence
        : state.nextBefore,
    lastCreatedSequence: Math.max(
      state.lastCreatedSequence,
      ...events.map((event) => event.message.createdSequence),
    ),
    lastMutationSequence: Math.max(
      state.lastMutationSequence,
      ...events
        .filter(observesMutation)
        .map((event) =>
          Math.max(event.sequence, event.message.updatedSequence),
        ),
    ),
    cursor: cursor
      ? {
          ...cursor,
          sequence: Math.max(state.cursor.sequence, cursor.sequence),
        }
      : state.cursor,
  };
}
