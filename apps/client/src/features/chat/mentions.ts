/**
 * Composer mentions. The author types and reads display names; the wire body
 * carries empty Markdown identity links tokens, which the owning actor validates.
 *
 * A chosen mention is tracked as the exact range it occupies in the draft, not
 * as a name to search for later. Ranges are what make the rewrite honest: two
 * members can share a display name, `@Jo` cannot swallow the `hn` of a `@John`
 * the author typed by hand, and a name that ends up inside code is left alone.
 * Every edit shifts the ranges after it and unbinds the ones it reaches into,
 * so a mention that can no longer be trusted is sent as the plain text it looks
 * like. These helpers are pure: nothing here reads the textarea or the network.
 */
import { mentionTokens } from "@vaskel/contracts/message-text";

export { encodeMentions } from "./mention-projection";

/** A completion opens after `@`; a name may contain spaces, so scanning is bounded. */
const MENTION_QUERY_LIMIT = 48;
/**
 * Only an address character before `@` closes the completion. CJK and other
 * scripts write without spaces, so `おはよう@ra` must still offer the list.
 */
const ADDRESS = /[A-Za-z0-9._%+-]/u;

export interface MentionCandidate {
  userId: string;
  name: string;
}

/** Where a chosen `@Name` sits in the draft, and who it names. */
export interface MentionRange {
  start: number;
  end: number;
  userId: string;
}

export interface MentionDraft {
  readonly body: string;
  readonly mentions: readonly MentionRange[];
}

export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

/** Selection before a native edit and the caret after it. */
export interface EditSelection {
  readonly start: number;
  readonly end: number;
  readonly caret: number;
}

/** Existing tokens become readable names without conflating equal names. */
export function decodeMentionDraft(
  body: string,
  names: ReadonlyMap<string, string> | undefined,
  fallbackName: string,
): MentionDraft {
  let display = "";
  let index = 0;
  const mentions: MentionRange[] = [];
  for (const token of mentionTokens(body)) {
    display += body.slice(index, token.start);
    const start = display.length;
    display += `@${names?.get(token.userId) ?? fallbackName}`;
    mentions.push({ start, end: display.length, userId: token.userId });
    index = token.end;
  }
  return { body: display + body.slice(index), mentions };
}

export function editMentionDraft(
  draft: MentionDraft,
  body: string,
  selection?: EditSelection,
): MentionDraft {
  return {
    body,
    mentions: shiftMentionRanges(
      draft.mentions,
      editSpan(draft.body, body, selection),
    ),
  };
}

/** One explicit replacement, including when the new name looks identical. */
export function completeMentionDraft(
  draft: MentionDraft,
  query: MentionQuery,
  candidate: MentionCandidate,
): { draft: MentionDraft; caret: number } {
  const queryEnd = query.start + 1 + query.query.length;
  const existing = draft.mentions.find(
    (range) => range.start === query.start && queryEnd <= range.end,
  );
  const nameEnd = existing?.end ?? queryEnd;
  const end = draft.body.charAt(nameEnd) === " " ? nameEnd + 1 : nameEnd;
  const insert = `@${candidate.name} `;
  const edit = { start: query.start, removed: end - query.start, insert };
  return {
    draft: {
      body: draft.body.slice(0, query.start) + insert + draft.body.slice(end),
      mentions: [
        ...shiftMentionRanges(draft.mentions, edit),
        {
          start: query.start,
          end: query.start + insert.length - 1,
          userId: candidate.userId,
        },
      ],
    },
    caret: query.start + insert.length,
  };
}

/** The one contiguous span of `before` that `after` replaced. */
export interface EditSpan {
  start: number;
  removed: number;
  insert: string;
}

/**
 * The `@…` the caret sits in, or null. Scanning stops at the first `@` to the
 * left: an address such as `name@example.com` has an address character before
 * it, so it never opens a completion, and a line break ends the search.
 */
export function findMentionQuery(
  value: string,
  caret: number,
): MentionQuery | null {
  const end = Math.max(0, Math.min(caret, value.length));
  for (
    let index = end - 1;
    index >= 0 && end - index <= MENTION_QUERY_LIMIT;
    index--
  ) {
    const character = value.charAt(index);
    if (character === "\n") return null;
    if (character !== "@") continue;
    const before = index === 0 ? "" : value.charAt(index - 1);
    if (before !== "" && ADDRESS.test(before)) return null;
    const query = value.slice(index + 1, end);
    return query.startsWith(" ") ? null : { start: index, query };
  }
  return null;
}

/**
 * Locale-insensitive containment: a name matches when the query equals one of
 * its runs of characters under the collator, which ignores case and accents.
 * A match at the start ranks above one inside the name.
 */
export function matchMentionName(
  name: string,
  query: string,
  collator: Intl.Collator,
): "prefix" | "substring" | null {
  const characters = [...name];
  const wanted = [...query];
  if (wanted.length === 0) return "prefix";
  if (wanted.length > characters.length) return null;
  for (let start = 0; start + wanted.length <= characters.length; start++) {
    const run = characters.slice(start, start + wanted.length).join("");
    if (collator.compare(run, query) === 0)
      return start === 0 ? "prefix" : "substring";
  }
  return null;
}

/** The people the completion offers, best match first and bounded for display. */
export function rankMentions(
  candidates: readonly MentionCandidate[],
  query: string,
  collator: Intl.Collator,
  limit = 8,
): MentionCandidate[] {
  const ranked: { candidate: MentionCandidate; rank: number }[] = [];
  for (const candidate of candidates) {
    const match = matchMentionName(candidate.name, query, collator);
    if (match) ranked.push({ candidate, rank: match === "prefix" ? 0 : 1 });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank || collator.compare(a.candidate.name, b.candidate.name),
  );
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

/**
 * The difference between two values of one controlled field, as a single span.
 * Native selection distinguishes equal names. Prefix/suffix comparison is the
 * fallback for programmatic changes or edits without a usable selection.
 */
export function editSpan(
  before: string,
  after: string,
  selection?: EditSelection,
): EditSpan {
  if (selection) {
    // Equal names make prefix/suffix diffing ambiguous. Native selection and
    // the resulting caret identify which occurrence was actually replaced.
    const start = Math.min(selection.start, selection.caret);
    const inserted = selection.caret - start;
    const removed = before.length - after.length + inserted;
    const end = start + removed;
    if (
      start >= 0 &&
      removed >= 0 &&
      end >= selection.end &&
      end <= before.length &&
      before.slice(0, start) === after.slice(0, start) &&
      before.slice(end) === after.slice(selection.caret)
    )
      return { start, removed, insert: after.slice(start, selection.caret) };
  }
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before.charAt(prefix) === after.charAt(prefix))
    prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before.charAt(before.length - 1 - suffix) ===
      after.charAt(after.length - 1 - suffix)
  )
    suffix += 1;
  return {
    start: prefix,
    removed: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Moves the ranges an edit pushed around and unbinds the ones it compromised.
 * An edit that reaches into a name ends that binding: the text stays, the
 * identifier does not. Writing directly onto the end of a name ends it only
 * when the new text continues the name — `@Jo` typed on to read `@John` is a
 * different person — while punctuation or a space after it changes nothing,
 * which is how a name works in scripts that are written without spaces.
 */
export function shiftMentionRanges(
  ranges: readonly MentionRange[],
  edit: EditSpan,
): MentionRange[] {
  const delta = edit.insert.length - edit.removed;
  const editEnd = edit.start + edit.removed;
  const shifted: MentionRange[] = [];
  for (const range of ranges) {
    if (editEnd <= range.start)
      shifted.push({
        ...range,
        start: range.start + delta,
        end: range.end + delta,
      });
    else if (edit.start < range.end) continue;
    else if (edit.start > range.end || !continuesName(edit.insert))
      shifted.push({ ...range });
  }
  return shifted;
}

/** Letters, digits and marks read as more of the name; anything else ends it. */
function continuesName(insert: string): boolean {
  const [first] = insert;
  return first !== undefined && /[\p{L}\p{N}\p{M}]/u.test(first);
}
