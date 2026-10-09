import { apiFailure } from "@/client/api/errors";
import { z } from "zod";
import type { UiLanguage } from "@vaskel/contracts/preferences";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import {
  NotificationCommandSchema,
  NotificationOutcomeSchema,
  type NotificationCommand,
  type NotificationState,
} from "@vaskel/contracts/notifications";

import {
  fetchNotificationState,
  notificationCommand,
} from "@/client/api/notifications";
import { message, UiMessageError } from "@/client/features/i18n/messages";

const bindingKey = "vaskel.notification-binding";
const lockName = "vaskel.notification-subscription";
const BindingSchema = z.object({
  accountId: z.string(),
  deviceId: z.string().uuid(),
  endpoint: z.string().nullable(),
  subscriptionVersion: z.number().int().nullable(),
  cleanupFailed: z.boolean(),
  pending: NotificationCommandSchema.nullable(),
});
export type BrowserEnrollment = z.infer<typeof BindingSchema>;
export type EnrollmentGuard = { accountId: string; current: () => boolean };
const listeners = new Set<() => void>();
/** Sign-out cleanups still running in this tab; their persisted obligation is not yet a failure. */
let activeCleanups = 0;
export const subscribeEnrollment = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
export function readEnrollment(): BrowserEnrollment | null {
  try {
    const raw = localStorage.getItem(bindingKey);
    if (!raw) return null;
    const result = BindingSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
export function cleanupFailed() {
  return activeCleanups === 0 && (readEnrollment()?.cleanupFailed ?? false);
}
function notify() {
  for (const listener of listeners) listener();
}
function save(binding: BrowserEnrollment | null) {
  if (binding) localStorage.setItem(bindingKey, JSON.stringify(binding));
  else localStorage.removeItem(bindingKey);
  notify();
}
function check(guard: EnrollmentGuard) {
  if (!guard.current()) throw new DOMException("Account changed", "AbortError");
}
export function browserNotificationSupport() {
  return (
    window.isSecureContext &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator &&
    "locks" in navigator
  );
}
function publicKey(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function registration() {
  const result = await navigator.serviceWorker.getRegistration("/");
  if (!result?.active)
    throw new UiMessageError(message("notifications.installHint"));
  return result;
}
/** This browser's current push subscription, whichever account it belongs to. */
export async function readBrowserSubscription(): Promise<{
  endpoint: string;
} | null> {
  if (!browserNotificationSupport()) return null;
  const worker = await navigator.serviceWorker.getRegistration("/");
  const subscription = worker?.active
    ? await worker.pushManager.getSubscription()
    : null;
  return subscription ? { endpoint: subscription.endpoint } : null;
}
function commandBase(state: NotificationState) {
  return {
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedRevision: state.revision,
  };
}
/** Definitive rejections release a command; uncertain transport outcomes keep its identity. */
async function sendBoundCommand(
  guard: EnrollmentGuard,
  binding: BrowserEnrollment,
  command: NotificationCommand,
) {
  try {
    return await notificationCommand(guard.accountId, command);
  } catch (error) {
    if (
      guard.current() &&
      apiFailure(error) &&
      [
        "stale_revision",
        "command_expired",
        "command_conflict",
        "invalid_input",
        "capacity",
        "not_found",
      ].includes(apiFailure(error)?.code ?? "") &&
      readEnrollment()?.deviceId === binding.deviceId
    )
      save({ ...binding, pending: null });
    throw error;
  }
}
/** Permission starts in the click handler, before waiting on storage or another tab. */
export async function enableNotifications(
  guard: EnrollmentGuard,
  label: string,
  language: UiLanguage,
): Promise<NotificationState> {
  check(guard);
  if (!browserNotificationSupport())
    throw new UiMessageError(message("notifications.unsupported"));
  const permission = await Notification.requestPermission();
  check(guard);
  if (permission !== "granted")
    throw new UiMessageError(
      permission === "denied"
        ? message("notifications.permissionBlocked")
        : message("notifications.permissionDismissed"),
    );
  return navigator.locks.request(lockName, async () => {
    check(guard);
    let binding = readEnrollment();
    if (binding && binding.accountId !== guard.accountId)
      throw new UiMessageError(message("notifications.otherAccount"));
    const worker = await registration();
    check(guard);
    let subscription = await worker.pushManager.getSubscription();
    check(guard);
    // A subscription this binding does not own is released explicitly, never adopted.
    if (subscription && subscription.endpoint !== binding?.endpoint)
      throw new UiMessageError(message("notifications.orphanedSubscription"));
    // The actor's current state, not the caller's view, decides what this tab may replace.
    const state = await fetchNotificationState(guard.accountId);
    check(guard);
    if (binding?.pending?.kind === "enable") {
      // Retry an ambiguous Enable with exactly the persisted command identity. A
      // name typed since needs a new command: the actor rejects a changed
      // payload under a known command id, and the person expects the new name.
      const command: NotificationCommand =
        binding.pending.label === label
          ? binding.pending
          : { ...binding.pending, ...commandBase(state), label };
      if (command !== binding.pending) {
        binding = { ...binding, pending: command };
        save(binding);
      }
      const result = await sendBoundCommand(guard, binding, command);
      check(guard);
      const device = result.devices.find(
        (item) => item.deviceId === binding?.deviceId,
      );
      save({
        ...binding,
        subscriptionVersion: device?.subscriptionVersion ?? null,
        pending: null,
        cleanupFailed: false,
      });
      return result;
    }
    if (
      binding &&
      state.devices.some((item) => item.deviceId === binding?.deviceId)
    )
      return state;
    // Only this explicit Enable may replace an enrollment removed elsewhere.
    if (subscription) {
      await subscription.unsubscribe();
      check(guard);
    }
    binding = {
      accountId: guard.accountId,
      deviceId: crypto.randomUUID(),
      endpoint: null,
      subscriptionVersion: null,
      pending: null,
      cleanupFailed: false,
    };
    save(binding); // Storage must work before creating a browser subscription.
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey(state.publicKey),
    });
    if (!guard.current()) {
      await subscription.unsubscribe();
      throw new DOMException("Account changed", "AbortError");
    }
    const json = subscription.toJSON();
    const command: NotificationCommand = {
      ...commandBase(state),
      kind: "enable",
      language,
      deviceId: binding.deviceId,
      label,
      subscription: {
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
      },
    };
    binding = { ...binding, endpoint: subscription.endpoint, pending: command };
    try {
      save(binding);
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }
    const result = await sendBoundCommand(guard, binding, command);
    check(guard);
    const device = result.devices.find(
      (item) => item.deviceId === binding?.deviceId,
    );
    save({
      ...binding,
      subscriptionVersion: device?.subscriptionVersion ?? null,
      pending: null,
    });
    return result;
  });
}
export async function removeNotifications(
  guard: EnrollmentGuard,
  deviceId: string,
): Promise<NotificationState> {
  check(guard);
  const operation = async () => {
    check(guard);
    const binding = readEnrollment();
    const local =
      binding?.accountId === guard.accountId && binding.deviceId === deviceId;
    const state = await fetchNotificationState(guard.accountId);
    check(guard);
    const device = state.devices.find((item) => item.deviceId === deviceId);
    let result = state;
    // A device the actor no longer lists needs no command; this browser still tidies itself.
    if (device) {
      const command: NotificationCommand =
        local && binding.pending?.kind === "remove"
          ? binding.pending
          : {
              ...commandBase(state),
              kind: "remove",
              deviceId,
              subscriptionVersion: device.subscriptionVersion,
            };
      if (local) save({ ...binding, pending: command });
      result = local
        ? await sendBoundCommand(guard, binding, command)
        : await notificationCommand(guard.accountId, command);
      check(guard);
    }
    if (local) {
      try {
        const subscription = await (
          await registration()
        ).pushManager.getSubscription();
        check(guard);
        if (subscription?.endpoint === binding.endpoint)
          await subscription.unsubscribe();
        check(guard);
        save(null);
      } catch (error) {
        const retained = readEnrollment();
        if (
          guard.current() &&
          retained?.accountId === binding.accountId &&
          retained.deviceId === binding.deviceId
        )
          save({ ...binding, pending: null, cleanupFailed: true });
        throw error;
      }
    }
    return result;
  };
  return "locks" in navigator
    ? navigator.locks.request(lockName, operation)
    : operation();
}
/** Releases a subscription no binding owns; another account's binding is never touched. */
export async function releaseOrphanedSubscription(
  guard: EnrollmentGuard,
): Promise<void> {
  check(guard);
  if (!browserNotificationSupport())
    throw new UiMessageError(message("notifications.unsupported"));
  return navigator.locks.request(lockName, async () => {
    check(guard);
    const binding = readEnrollment();
    if (binding && binding.accountId !== guard.accountId)
      throw new UiMessageError(message("notifications.otherAccount"));
    const worker = await navigator.serviceWorker.getRegistration("/");
    check(guard);
    const subscription = await worker?.pushManager.getSubscription();
    check(guard);
    if (!subscription || subscription.endpoint === binding?.endpoint) return;
    await subscription.unsubscribe();
    check(guard);
    // A browser holds one subscription, so a binding naming another endpoint is dead.
    if (binding) save(null);
  });
}
/** Captured authenticated cleanup is best effort and never delays signing out. */
export function cleanupNotificationsOnLogout(accountId: string) {
  const captured = readEnrollment();
  if (!captured || captured.accountId !== accountId) return;
  const operation = async () => {
    const current = readEnrollment();
    if (
      !current ||
      current.deviceId !== captured.deviceId ||
      current.accountId !== accountId
    )
      return;
    // Persisted first so a closed tab keeps the obligation; shown only once this tab knows it failed.
    activeCleanups += 1;
    try {
      save({ ...current, cleanupFailed: true });
      const headers = {
        "Content-Type": "application/json",
        [EXPECTED_ACCOUNT_HEADER]: accountId,
      };
      const actor = async () => {
        const response = await fetch("/api/notifications", {
          headers,
          credentials: "same-origin",
        });
        const result = NotificationOutcomeSchema.parse(await response.json());
        if (result.kind !== "notification_state")
          throw new Error("Cleanup unavailable");
        const device = result.state.devices.find(
          (item) => item.deviceId === captured.deviceId,
        );
        if (!device) return;
        const command = {
          ...commandBase(result.state),
          kind: "remove",
          deviceId: device.deviceId,
          subscriptionVersion: device.subscriptionVersion,
        };
        const removed = await fetch("/api/notifications/commands", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify(command),
          keepalive: true,
        });
        const outcome = NotificationOutcomeSchema.parse(await removed.json());
        if (outcome.kind !== "notification_updated")
          throw new Error("Cleanup unavailable");
      };
      const browser = async () => {
        const worker = await navigator.serviceWorker.getRegistration("/");
        const subscription = await worker?.pushManager.getSubscription();
        if (subscription?.endpoint === captured.endpoint)
          await subscription.unsubscribe();
      };
      const outcomes = await Promise.allSettled([actor(), browser()]);
      const latest = readEnrollment();
      if (
        latest?.deviceId !== captured.deviceId ||
        latest.accountId !== accountId
      )
        return;
      if (outcomes.every((result) => result.status === "fulfilled")) save(null);
    } finally {
      activeCleanups -= 1;
      notify();
    }
  };
  void (
    "locks" in navigator
      ? navigator.locks.request(lockName, operation)
      : operation()
  ).catch(() => {});
}
