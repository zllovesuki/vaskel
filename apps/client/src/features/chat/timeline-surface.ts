/**
 * Pure decisions for the transcript surface: which commands a message row
 * offers on its hover toolbar and inside its menu, and where the
 * start-of-history intro belongs. Rendering stays in the components.
 */

export type MessageActionId =
  "react" | "reply" | "forward" | "copy-link" | "edit" | "delete";

/** A command is available only when the row received its handler. */
export interface MessageActionAvailability {
  react?: boolean | undefined;
  reply?: boolean | undefined;
  forward?: boolean | undefined;
  copyLink?: boolean | undefined;
  edit?: boolean | undefined;
  remove?: boolean | undefined;
}

/** Menu order: every available command stays reachable from one menu. */
export function messageActionIds(
  available: MessageActionAvailability,
): MessageActionId[] {
  const ids: MessageActionId[] = [];
  if (available.react) ids.push("react");
  if (available.reply) ids.push("reply");
  if (available.forward) ids.push("forward");
  if (available.copyLink) ids.push("copy-link");
  if (available.edit) ids.push("edit");
  if (available.remove) ids.push("delete");
  return ids;
}

/**
 * Toolbar conveniences beside More; destructive commands, the link and the
 * touch-only reaction entry stay in the menu. Reacting leads, as the most
 * frequent reply to a message that needs no words.
 */
export function messageToolbarIds(
  available: MessageActionAvailability,
): MessageActionId[] {
  return messageActionIds(available).filter(
    (id) => id === "react" || id === "reply" || id === "forward",
  );
}

export interface TimelineIntro {
  kind: "room" | "conversation";
  name: string;
}

/**
 * A paging control at one edge of the window, present only while a page in that
 * direction remains unloaded. The newer edge exists only while a jump holds a
 * historical range; at the latest window, Jump to latest takes over.
 */
export interface HistoryPaging {
  pending: boolean;
  disabled: boolean;
  load: () => void;
}

/**
 * The intro belongs at the beginning of history only: an earlier page left to
 * load means the first rendered row is not the first message ever sent here.
 */
export function timelineIntroPlacement({
  intro,
  loadEarlier,
  messageCount,
}: {
  intro?: TimelineIntro | undefined;
  loadEarlier?: HistoryPaging | undefined;
  messageCount: number;
}): "none" | "leading" | "empty" {
  if (!intro || loadEarlier) return "none";
  return messageCount === 0 ? "empty" : "leading";
}
