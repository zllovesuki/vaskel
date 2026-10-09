import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { registerSW } from "virtual:pwa-register";

const helper = vi.hoisted(() => ({ registerSW: vi.fn<typeof registerSW>() }));
vi.mock("virtual:pwa-register", () => helper);

let callbacks: NonNullable<Parameters<typeof registerSW>[0]>;
let documentEvents: EventTarget & { visibilityState: string };
let windowEvents: EventTarget;
let browser: {
  serviceWorker?: { controller: object | null };
  onLine: boolean;
};
let registration: {
  installing: object | null;
  waiting: object | null;
  update: ReturnType<typeof vi.fn<() => Promise<void>>>;
};
const activate = vi.fn(async () => {});
const reload = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("PROD", true);
  documentEvents = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  windowEvents = Object.assign(new EventTarget(), {
    setInterval: globalThis.setInterval,
    location: { reload },
  });
  browser = { serviceWorker: { controller: null }, onLine: true };
  registration = {
    installing: null,
    waiting: null,
    update: vi.fn(async () => {}),
  };
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("navigator", browser);
  helper.registerSW.mockImplementation((options) => {
    callbacks = options!;
    return activate;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function registered() {
  callbacks.onRegisteredSW?.(
    "/sw.js",
    registration as unknown as ServiceWorkerRegistration,
  );
}

it("does not register in development or without browser support", async () => {
  const shell = await import("@/client/shell/register");
  vi.stubEnv("PROD", false);
  shell.registerOfflineShell();
  vi.stubEnv("PROD", true);
  delete browser.serviceWorker;
  shell.registerOfflineShell();
  expect(helper.registerSW).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("owns one set of discovery triggers and coalesces visible online checks", async () => {
  const shell = await import("@/client/shell/register");
  const documentListener = vi.spyOn(documentEvents, "addEventListener");
  const windowListener = vi.spyOn(windowEvents, "addEventListener");
  let finish!: () => void;
  registration.update.mockImplementationOnce(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  shell.registerOfflineShell();
  shell.registerOfflineShell();
  registered();
  expect(helper.registerSW).toHaveBeenCalledTimes(1);
  expect(documentListener).toHaveBeenCalledTimes(1);
  expect(windowListener).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  windowEvents.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(registration.update).toHaveBeenCalledTimes(1);
  finish();
  await Promise.resolve();

  documentEvents.visibilityState = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  documentEvents.visibilityState = "visible";
  browser.onLine = false;
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  browser.onLine = true;
  registration.installing = {};
  windowEvents.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(registration.update).toHaveBeenCalledTimes(1);

  registration.installing = null;
  windowEvents.dispatchEvent(new Event("online"));
  await Promise.resolve();
  expect(registration.update).toHaveBeenCalledTimes(2);
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(registration.update).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(registration.update).toHaveBeenCalledTimes(4);
  expect(shell.getShellUpdateAvailable()).toBe(false);
  expect(activate).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("keeps failures silent and allows the next discovery trigger to retry", async () => {
  const shell = await import("@/client/shell/register");
  shell.registerOfflineShell();
  callbacks.onRegisterError?.(new Error("Storage unavailable"));
  callbacks.onRegisteredSW?.("/sw.js", undefined);
  expect(vi.getTimerCount()).toBe(0);
  expect(shell.getShellUpdateAvailable()).toBe(false);

  registration.update.mockRejectedValueOnce(new Error("Offline"));
  registered();
  await Promise.resolve();
  expect(shell.getShellUpdateAvailable()).toBe(false);
  windowEvents.dispatchEvent(new Event("online"));
  await Promise.resolve();
  expect(registration.update).toHaveBeenCalledTimes(2);
  expect(shell.getShellUpdateAvailable()).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

it("keeps the update available after canceled reload and supports unsubscribing", async () => {
  const shell = await import("@/client/shell/register");
  const listener = vi.fn();
  const removed = vi.fn();
  shell.subscribeShellUpdate(listener);
  shell.subscribeShellUpdate(removed)();
  shell.registerOfflineShell();
  registered();
  registration.waiting = {};
  callbacks.onNeedRefresh?.();
  callbacks.onNeedRefresh?.();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(removed).not.toHaveBeenCalled();
  shell.reloadToUpdate();
  expect(activate).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();

  browser.serviceWorker = { controller: registration.waiting };
  registration.waiting = null;
  callbacks.onNeedReload?.();
  callbacks.onNeedReload?.();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(shell.getShellUpdateAvailable()).toBe(true);
  shell.reloadToUpdate();
  expect(reload).toHaveBeenCalledTimes(2);
  expect(shell.getShellUpdateAvailable()).toBe(true);

  browser.serviceWorker = { controller: {} };
  callbacks.onNeedReload?.();
  expect(reload).toHaveBeenCalledTimes(3);
});
