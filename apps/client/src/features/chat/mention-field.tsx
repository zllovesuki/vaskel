import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type RefObject,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { membersOptions } from "@/client/api/members";
import { peopleByIdOptions } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useI18n } from "@/client/features/i18n/use-i18n";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { floatingPanelStyles } from "@vaskel/ui/components/control-styles";
import {
  completeMentionDraft,
  editMentionDraft,
  findMentionQuery,
  rankMentions,
  type MentionCandidate,
  type MentionDraft,
  type MentionQuery,
} from "./mentions";

export type MentionFieldHandle = { insertText: (text: string) => void };

/** The composer and editor share the same readable draft and completion field. */
export function MentionField({
  ref,
  draft,
  onDraftChange,
  owner,
  channelId,
  online,
  textareaRef,
  wrapperClassName,
  className,
  onChange,
  onClick,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  ...field
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  ref?: Ref<MentionFieldHandle>;
  draft: MentionDraft;
  onDraftChange: (draft: MentionDraft) => void;
  owner: OwnerScope;
  channelId: string;
  online: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  wrapperClassName?: string;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
}) {
  const user = useUser();
  const { t, language } = useI18n();
  const localTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = textareaRef ?? localTextarea;
  const selection = useRef<{ start: number; end: number } | null>(null);
  const caret = useRef<number | null>(null);
  const composing = useRef(false);
  const [completion, setCompletion] = useState<{
    body: string;
    mention: MentionQuery;
  } | null>(null);
  const mention = completion?.body === draft.body ? completion.mention : null;
  const [highlighted, setHighlighted] = useState(0);
  const listId = useId();
  const editable = online && !field.disabled && !field.readOnly;
  const collator = useMemo(
    () => new Intl.Collator(language, { sensitivity: "base" }),
    [language],
  );
  const members = useQuery({
    ...membersOptions(user.userId, owner),
    enabled: editable && mention !== null,
  });
  const memberIds = (() => {
    if (!members.data) return [];
    const channel = members.data.channelMembers.find(
      (entry) => entry.channelId === channelId,
    );
    const allowed = channel ? new Set(channel.userIds) : null;
    return members.data.members
      .map((member) => member.userId)
      .filter(
        (id) => id !== user.userId && (allowed === null || allowed.has(id)),
      );
  })();
  const people = useQuery({
    ...peopleByIdOptions(user.userId, memberIds),
    enabled: editable && mention !== null && memberIds.length > 0,
  });
  const known = new Set(memberIds);
  const candidates =
    editable && mention
      ? rankMentions(
          (people.data ?? [])
            .filter((person) => known.has(person.userId))
            .map((person) => ({
              userId: person.userId,
              name: person.displayName,
            })),
          mention.query,
          collator,
        )
      : [];
  const completing = mention !== null && candidates.length > 0;
  const active = Math.min(highlighted, Math.max(0, candidates.length - 1));

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    // Native beforeinput also covers deletion, paste, drop and IME commits.
    // The selection disambiguates edits between identical display names.
    const beforeInput = () => {
      selection.current = {
        start: element.selectionStart,
        end: element.selectionEnd,
      };
    };
    element.addEventListener("beforeinput", beforeInput);
    return () => element.removeEventListener("beforeinput", beforeInput);
  }, [textarea]);
  useLayoutEffect(() => {
    const position = caret.current;
    if (position === null) return;
    caret.current = null;
    textarea.current?.setSelectionRange(position, position);
  }, [draft, textarea]);

  useImperativeHandle(
    ref,
    () => ({
      insertText(text) {
        const element = textarea.current;
        if (!element || !editable || composing.current) return;
        const start = element.selectionStart;
        const end = element.selectionEnd;
        const position = start + text.length;
        selection.current = null;
        caret.current = position;
        onDraftChange(
          editMentionDraft(
            draft,
            draft.body.slice(0, start) + text + draft.body.slice(end),
            { start, end, caret: position },
          ),
        );
        setCompletion(null);
        setHighlighted(0);
        element.focus({ preventScroll: true });
      },
    }),
    [draft, editable, onDraftChange, textarea],
  );

  function updateMention(element: HTMLTextAreaElement) {
    const next = editable
      ? findMentionQuery(element.value, element.selectionStart)
      : null;
    setCompletion(next ? { body: element.value, mention: next } : null);
    setHighlighted(0);
  }
  function complete(candidate: MentionCandidate) {
    if (!mention || !editable) return;
    const completed = completeMentionDraft(draft, mention, candidate);
    caret.current = completed.caret;
    onDraftChange(completed.draft);
    setCompletion(null);
    setHighlighted(0);
    textarea.current?.focus();
  }
  return (
    <div className={`relative ${wrapperClassName ?? ""}`}>
      {completing && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("chat.mentionSuggestions")}
          data-side="top"
          className={`absolute bottom-full left-0 z-20 mb-1 max-h-60 w-[min(320px,100%)] overflow-auto p-1 ${floatingPanelStyles}`}
        >
          {candidates.map((candidate, index) => (
            <li
              key={candidate.userId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // The keyboard's choice keeps the accent; the pointer's washes.
              className="flex min-h-target cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-ui hover:bg-wash active:bg-press aria-selected:bg-accent-soft aria-selected:text-ink"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => complete(candidate)}
            >
              {candidate.name}
            </li>
          ))}
        </ul>
      )}
      <textarea
        {...field}
        // Android Firefox can auto-zoom a focused field even at 16px. With its
        // bottom toolbar and the keyboard open, this made scrolling feel stuck.
        // `manipulation` suppresses focus zoom but preserves panning and pinch zoom.
        className={`touch-manipulation ${className ?? ""}`}
        ref={textarea}
        value={draft.body}
        onCompositionStart={(event) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onCompositionEnd?.(event);
        }}
        {...(completing
          ? {
              role: "combobox",
              "aria-expanded": true,
              "aria-controls": listId,
              "aria-autocomplete": "list" as const,
              "aria-activedescendant": `${listId}-${active}`,
            }
          : {})}
        onChange={(event) => {
          const before = selection.current;
          selection.current = null;
          onDraftChange(
            editMentionDraft(
              draft,
              event.target.value,
              before
                ? { ...before, caret: event.target.selectionStart }
                : undefined,
            ),
          );
          updateMention(event.target);
          onChange?.(event);
        }}
        onClick={(event) => {
          updateMention(event.currentTarget);
          onClick?.(event);
        }}
        onBlur={(event) => {
          setCompletion(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (completing) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted(
                (active +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  candidates.length) %
                  candidates.length,
              );
              return;
            }
            if (
              (event.key === "Enter" && !event.shiftKey) ||
              event.key === "Tab"
            ) {
              const candidate = candidates[active];
              if (!candidate) return;
              event.preventDefault();
              complete(candidate);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setCompletion(null);
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
    </div>
  );
}
