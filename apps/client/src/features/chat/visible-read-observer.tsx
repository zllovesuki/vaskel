import { useEffect, type RefObject } from "react";

/** Mounted only after account and selected owner access have been revalidated. */
export function VisibleReadObserver({
  scroll,
  visibleIds,
  markRead,
}: {
  scroll: RefObject<HTMLDivElement | null>;
  visibleIds: string;
  markRead: (sequence: number) => void;
}) {
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const visible = new Map<Element, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    function advance() {
      clearTimeout(timer);
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        !navigator.onLine
      )
        return;
      const maximum = Math.max(0, ...visible.values());
      if (maximum)
        timer = setTimeout(() => {
          if (document.visibilityState === "visible" && document.hasFocus())
            markRead(maximum);
        }, 500);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sequence = Number(
            (entry.target as HTMLElement).dataset.sequence,
          );
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5)
            visible.set(entry.target, sequence);
          else visible.delete(entry.target);
        }
        advance();
      },
      { root: element, threshold: [0, 0.5] },
    );
    for (const message of element.querySelectorAll("[data-sequence]"))
      observer.observe(message);
    document.addEventListener("visibilitychange", advance);
    window.addEventListener("focus", advance);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", advance);
      window.removeEventListener("focus", advance);
    };
  }, [scroll, visibleIds, markRead]);
  return null;
}
