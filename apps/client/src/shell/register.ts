import { registerSW } from "virtual:pwa-register";

let started = false;
let updateAvailable = false;
let registration: ServiceWorkerRegistration | undefined;
let updateServiceWorker: ReturnType<typeof registerSW> | undefined;
let reloadAttemptedFor: ServiceWorker | null = null;
const listeners = new Set<() => void>();

export function getShellUpdateAvailable() {
  return updateAvailable;
}

export function subscribeShellUpdate(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function offerUpdate() {
  if (updateAvailable) return;
  updateAvailable = true;
  for (const listener of listeners) listener();
}

export function reloadToUpdate() {
  if (registration?.waiting && updateServiceWorker) {
    void updateServiceWorker().catch(() => {
      // Keep the action available if activation could not be requested.
    });
  } else {
    // Activation can succeed even when a browser unload warning cancels reload.
    window.location.reload();
  }
}

/** One document owns registration; source/HMR development registers no worker. */
export function registerOfflineShell() {
  if (started || !import.meta.env.PROD || !("serviceWorker" in navigator))
    return;
  started = true;
  updateServiceWorker = registerSW({
    onNeedRefresh: offerUpdate,
    onNeedReload() {
      offerUpdate();
      const controller = navigator.serviceWorker.controller;
      if (!controller || controller === reloadAttemptedFor) return;
      // Duplicate activation callbacks must not retry a canceled unload.
      reloadAttemptedFor = controller;
      window.location.reload();
    },
    onRegisteredSW(_url, registered) {
      if (!registered) return;
      registration = registered;
      let checking = false;
      const check = async () => {
        if (
          checking ||
          registered.installing ||
          document.visibilityState !== "visible" ||
          !navigator.onLine
        )
          return;
        checking = true;
        try {
          await registered.update();
        } catch {
          // A later trigger retries discovery without disrupting the online app.
        } finally {
          checking = false;
        }
      };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("online", check);
      window.setInterval(check, 5 * 60 * 1_000);
      void check();
    },
    onRegisterError() {
      // Storage restrictions must not prevent the online application from opening.
    },
  });
}
