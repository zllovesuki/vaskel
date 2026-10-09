import { message, UiMessageError } from "@/client/features/i18n/messages";
import {
  acceptNewerWindow,
  acceptOlderSnapshot,
  beginTimelineNavigation,
  forwardAnchor,
  installAroundWindow,
  latestTimeline,
  sameStream,
  type Timeline,
  type TimelineAround,
  type TimelineSnapshot,
} from "@/client/features/chat/reconcile";

export type TimelineDirection = "older" | "latest" | "newer";
/** Navigation intent: an edge of the history, or an exact message to open at. */
export type TimelineNavigation = TimelineDirection | { at: number };
/** Only accepted navigation requests alignment; repeated destinations retain distinct revisions. */
export type TimelineDestination =
  | { kind: "latest"; revision: number }
  | { kind: "message"; revision: number; sequence: number };

export async function refreshTimelineSnapshot(
  fetchSnapshot: () => Promise<TimelineSnapshot>,
  read: () => Timeline | undefined,
): Promise<TimelineSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await fetchSnapshot();
    const state = read();
    if (
      !state ||
      !sameStream(state.cursor, snapshot.cursor) ||
      snapshot.cursor.sequence >=
        Math.max(state.cursor.sequence, state.lastMutationSequence)
    )
      return snapshot;
  }
  throw new UiMessageError(message("chat.historyChanged"));
}

/**
 * Opens the window around one message, or pages one window forward from a held
 * range. Both are historical reads: the caller keeps contiguous replay running,
 * a delayed response is discarded once navigation has moved on, and an observed
 * mutation re-requests the page instead of installing a stale version of a row.
 */
export async function navigateAroundTimeline({
  target,
  read,
  write,
  fetchAround,
  current,
  visibleSequence,
}: {
  /** An exact message to open at, or the next page after the held window. */
  target: number | "newer";
  read: () => Timeline | undefined;
  write: (state: Timeline) => void;
  fetchAround: (sequence: number) => Promise<TimelineAround>;
  current: () => boolean;
  visibleSequence: () => number | undefined;
}): Promise<boolean> {
  const previous = read();
  if (!previous || !current()) return false;
  // Forward paging continues from the resident tail, which the owner's window
  // includes; the reported anchor can be older than the rows actually held.
  const sequence = target === "newer" ? forwardAnchor(previous) : target;
  if (sequence === null) return false;
  const opening = beginTimelineNavigation(previous);
  write(opening);
  let installed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const around = await fetchAround(sequence);
      const state = read();
      if (
        !current() ||
        !state ||
        state.windowVersion !== opening.windowVersion ||
        !sameStream(state.cursor, opening.cursor)
      )
        return false;
      if (!sameStream(state.cursor, around.cursor))
        throw new UiMessageError(message("chat.historyChanged"));
      if (around.cursor.sequence < state.lastMutationSequence) continue;
      const next =
        target === "newer"
          ? acceptNewerWindow(state, around, visibleSequence())
          : installAroundWindow(state, around);
      if (!next) return false;
      write(next);
      installed = true;
      return true;
    }
    throw new UiMessageError(message("chat.historyChanged"));
  } finally {
    // A refused or failed page leaves the window as it was, so a reader who
    // was following the latest messages still is; nothing was held after all.
    if (!installed && previous.mode === "following") {
      const state = read();
      if (state && current() && state.windowVersion === opening.windowVersion)
        write({ ...state, mode: "following" });
    }
  }
}

/** The caller holds contiguous replay for Latest, and owns request cancellation. */
export async function navigateTimeline({
  direction,
  read,
  write,
  fetchSnapshot,
  current,
  visibleSequence,
}: {
  direction: "older" | "latest";
  read: () => Timeline | undefined;
  write: (state: Timeline) => void;
  fetchSnapshot: (before?: number) => Promise<TimelineSnapshot>;
  current: () => boolean;
  visibleSequence: () => number | undefined;
}): Promise<boolean> {
  const previous = read();
  if (!previous || !current()) return false;
  const before = direction === "older" ? previous.nextBefore : null;
  if (direction === "older" && before === null) return false;
  const opening = beginTimelineNavigation(previous);
  write(opening);
  // Sends do not make an older page stale, and Latest recovers concurrent sends
  // by resuming replay from the snapshot. Only observed mutations require retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await fetchSnapshot(before ?? undefined);
    const state = read();
    if (
      !current() ||
      !state ||
      state.windowVersion !== opening.windowVersion ||
      !sameStream(state.cursor, opening.cursor)
    )
      return false;
    if (!sameStream(state.cursor, snapshot.cursor))
      throw new UiMessageError(message("chat.historyChanged"));
    if (
      snapshot.cursor.sequence < state.lastMutationSequence ||
      (direction === "latest" &&
        snapshot.cursor.sequence < state.cursor.sequence)
    )
      continue;
    const next =
      direction === "older"
        ? acceptOlderSnapshot(state, snapshot, visibleSequence())
        : latestTimeline(snapshot, state);
    if (!next) return false;
    write(next);
    return true;
  }
  throw new UiMessageError(message("chat.historyChanged"));
}
