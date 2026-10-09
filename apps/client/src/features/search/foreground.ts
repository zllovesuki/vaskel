/** One restart per return to the visible window, even when both events fire. */
export function observeSearchForeground(
  restart: () => void,
  windowTarget: EventTarget = window,
  documentTarget: EventTarget & {
    readonly visibilityState: DocumentVisibilityState;
    hasFocus(): boolean;
  } = document,
) {
  let foreground =
    documentTarget.visibilityState !== "hidden" && documentTarget.hasFocus();
  const leave = () => {
    foreground = false;
  };
  const enter = () => {
    if (documentTarget.visibilityState === "hidden" || foreground) return;
    foreground = true;
    restart();
  };
  const visibility = () => {
    if (documentTarget.visibilityState === "hidden") leave();
    else enter();
  };
  windowTarget.addEventListener("blur", leave);
  windowTarget.addEventListener("focus", enter);
  documentTarget.addEventListener("visibilitychange", visibility);
  return () => {
    windowTarget.removeEventListener("blur", leave);
    windowTarget.removeEventListener("focus", enter);
    documentTarget.removeEventListener("visibilitychange", visibility);
  };
}
