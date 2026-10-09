import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const STORAGE_KEY = "vaskel.theme";
const listeners = new Set<() => void>();

function readStoredChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
let choice = readStoredChoice();
export const getTheme = (): ThemeChoice => choice;

/**
 * Reflects the choice on the root element; the stylesheet does the rest. The
 * public/theme.js applies the same stored value before first paint.
 *
 * Controls ease their colours, so a switch would otherwise leave buttons
 * trailing the page into the new palette. Transitions stay off (base.css)
 * through the frame that computes the new palette and return in the next.
 */
export function applyTheme() {
  const root = document.documentElement;
  root.dataset.themeSwitching = "";
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => delete root.dataset.themeSwitching),
  );
}

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* Private windows may refuse storage; the choice still applies to this page. */
  }
  applyTheme();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      choice = readStoredChoice();
      applyTheme();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The device-level appearance choice. It is not an account setting. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore(
    subscribe,
    getTheme,
    (): ThemeChoice => "system",
  );
  return [choice, setTheme];
}
