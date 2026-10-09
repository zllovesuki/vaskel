import {
  useCallback,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Message } from "@vaskel/contracts/messaging";

/** Controls a focused row reaches with the arrow keys, in reading order. */
const ROW_CONTROLS = "a[href], button:not(:disabled), [tabindex]";

/** Visible, enabled controls inside one row, excluding an active edit or confirm scope. */
function rowControls(row: HTMLElement) {
  return Array.from(row.querySelectorAll<HTMLElement>(ROW_CONTROLS)).filter(
    (control) =>
      !control.closest("[data-focus-scope]") &&
      control.getClientRects().length > 0,
  );
}

export function useTimelineKeyboard(
  messages: Message[],
  scroll: RefObject<HTMLDivElement | null>,
  scrollToRow: (index: number) => void,
) {
  // One tab stop for the transcript: the current row carries it, the arrow
  // keys move it, and the container takes it only while that row is unmounted.
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const rowElement = useCallback(
    (index: number) => {
      const message = messages[index];
      return message
        ? scroll.current?.querySelector<HTMLElement>(
            `[data-timeline-sequence="${message.createdSequence}"] article`,
          )
        : undefined;
    },
    [messages, scroll],
  );
  function focusRow(index: number) {
    const clamped = Math.max(0, Math.min(messages.length - 1, index));
    const message = messages[clamped];
    if (!message) return;
    setActiveId(message.id);
    const element = rowElement(clamped);
    if (element) {
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest" });
      return;
    }
    // The row exists only once Virtual has placed it at the new offset.
    scrollToRow(clamped);
    requestAnimationFrame(() => {
      const placed = rowElement(clamped);
      if (placed) placed.focus({ preventScroll: true });
      else
        requestAnimationFrame(() =>
          rowElement(clamped)?.focus({ preventScroll: true }),
        );
    });
  }
  /** The last mounted row within the viewport, for entering without scrolling. */
  function visibleRowIndex() {
    const element = scroll.current;
    if (!element) return messages.length - 1;
    const viewport = element.getBoundingClientRect();
    let found = -1;
    for (const wrapper of element.querySelectorAll<HTMLElement>(
      "[data-index]",
    )) {
      const rect = wrapper.getBoundingClientRect();
      if (rect.top < viewport.bottom && rect.bottom > viewport.top)
        found = Math.max(found, Number(wrapper.dataset.index));
    }
    return found >= 0 ? found : messages.length - 1;
  }
  const pointerEntry = useRef(false);
  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget) {
      const wrapper = target.closest<HTMLElement>("[data-index]");
      const message = wrapper
        ? messages[Number(wrapper.dataset.index)]
        : undefined;
      if (message && message.id !== activeId) setActiveId(message.id);
      return;
    }
    // A pointer landing on empty transcript space keeps native scrolling.
    if (pointerEntry.current) return;
    const activeIndex = messages.findIndex(
      (message) => message.id === activeId,
    );
    focusRow(activeIndex >= 0 ? activeIndex : visibleRowIndex());
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !messages.length
    )
      return;
    const target = event.target as HTMLElement;
    // Editing surfaces and their confirms keep every key.
    if (target.closest("[data-focus-scope], textarea, input, select")) return;
    const row = target.closest<HTMLElement>("article");
    const wrapper = row?.closest<HTMLElement>("[data-index]");
    const index = wrapper
      ? Number(wrapper.dataset.index)
      : Math.max(
          0,
          messages.findIndex((message) => message.id === activeId),
        );
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        return;
      case "Home":
      case "End":
        if (target !== row) return;
        event.preventDefault();
        focusRow(event.key === "Home" ? 0 : messages.length - 1);
        return;
      case "ArrowRight":
      case "ArrowLeft": {
        if (!row) return;
        const controls = rowControls(row);
        if (!controls.length) return;
        event.preventDefault();
        const current = controls.indexOf(target);
        const step = event.key === "ArrowRight" ? 1 : -1;
        const next =
          current < 0
            ? step > 0
              ? 0
              : controls.length - 1
            : (current + step + controls.length) % controls.length;
        controls[next]?.focus({ preventScroll: true });
        return;
      }
      case "Escape":
        if (!row || target === row) return;
        event.preventDefault();
        row.focus({ preventScroll: true });
        return;
    }
  }
  return {
    activeId,
    onFocus,
    onKeyDown,
    onPointerDown: () => {
      pointerEntry.current = true;
    },
    onPointerUp: () => {
      pointerEntry.current = false;
    },
    onPointerCancel: () => {
      pointerEntry.current = false;
    },
  };
}
