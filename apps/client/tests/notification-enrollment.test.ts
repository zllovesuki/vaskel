import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/client/api/errors";
import type {
  NotificationCommand,
  NotificationState,
} from "@vaskel/contracts/notifications";
const api = vi.hoisted(() => ({ command: vi.fn(), state: vi.fn() }));
vi.mock("@/client/api/notifications", () => ({
  notificationCommand: api.command,
  fetchNotificationState: api.state,
}));
import {
  cleanupFailed,
  cleanupNotificationsOnLogout,
  enableNotifications,
  readBrowserSubscription,
  readEnrollment,
  releaseOrphanedSubscription,
  removeNotifications,
  subscribeEnrollment,
} from "@/client/features/notifications/browser";

const accountId = "9aca31ba-a6b9-48a5-bf7b-036ff2090229";
const deviceId = "39a513a0-ed4a-4c72-b905-05ef32c493b7";
const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/synthetic";
const subscription = {
  endpoint,
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({
    endpoint,
    keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
  }),
};
const permission = vi.fn(async () => "granted");
const getSubscription = vi.fn(
  async (): Promise<typeof subscription | null> => null,
);
const subscribe = vi.fn(
  async (_options: PushSubscriptionOptionsInit) => subscription,
);
const getRegistration = vi.fn(async () => ({
  active: {},
  pushManager: { getSubscription, subscribe },
}));
let storage: Map<string, string>;
const state: NotificationState = {
  accountId,
  revision: 1,
  publicKey: "AQID",
  preferences: { paused: false, preview: "generic", language: "en" },
  devices: [],
  rooms: [],
};
/** The actor's view when this browser's device is enrolled. */
const enrolled: NotificationState = {
  ...state,
  revision: 4,
  devices: [
    { deviceId, label: "Laptop", subscriptionVersion: 3, createdAt: 1 },
  ],
};
const current = vi.fn(() => true);
const guard = { accountId, current };
function bind(overrides: Record<string, unknown> = {}) {
  storage.set(
    "vaskel.notification-binding",
    JSON.stringify({
      accountId,
      deviceId,
      endpoint,
      subscriptionVersion: 1,
      pending: null,
      cleanupFailed: false,
      ...overrides,
    }),
  );
}
function accepted(command: NotificationCommand): NotificationState {
  return {
    ...state,
    revision: 2,
    devices:
      command.kind === "enable"
        ? [
            {
              deviceId: command.deviceId,
              label: command.label,
              subscriptionVersion: 1,
              createdAt: 1,
            },
          ]
        : [],
  };
}
function sentCommand(index: number) {
  return api.command.mock.calls[index]![1] as NotificationCommand;
}
beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", {
    isSecureContext: true,
    Notification: {},
    PushManager: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", { requestPermission: permission });
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration },
    locks: {
      request: async (_name: string, operation: () => unknown) => operation(),
    },
  });
  current.mockReturnValue(true);
  subscription.unsubscribe.mockResolvedValue(true);
  permission.mockResolvedValue("granted");
  getSubscription.mockResolvedValue(null);
  subscribe.mockResolvedValue(subscription);
  api.state.mockResolvedValue(state);
  api.command.mockImplementation(
    async (_account: string, command: NotificationCommand) => accepted(command),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("browser notification account binding", () => {
  it("rejects a lifetime changed while permission is pending, before creating a subscription", async () => {
    permission.mockImplementationOnce(async () => {
      current.mockReturnValue(false);
      return "granted";
    });
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getRegistration).not.toHaveBeenCalled();
    expect(api.command).not.toHaveBeenCalled();
  });
  it("tells a dismissed prompt apart from a blocked one, without touching the worker", async () => {
    permission.mockResolvedValueOnce("default");
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({
      uiMessage: { key: "notifications.permissionDismissed" },
    });
    permission.mockResolvedValueOnce("denied");
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({
      uiMessage: { key: "notifications.permissionBlocked" },
    });
    expect(getRegistration).not.toHaveBeenCalled();
    expect(api.state).not.toHaveBeenCalled();
  });
  it("unsubscribes a newly created subscription if the account changes during subscribe", async () => {
    subscribe.mockImplementationOnce(async () => {
      current.mockReturnValue(false);
      return subscription;
    });
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(api.command).not.toHaveBeenCalled();
  });
  it("enrolls against the actor's current key and revision, not the caller's view", async () => {
    api.state.mockResolvedValue({ ...state, revision: 7, publicKey: "BAUG" });
    await enableNotifications(guard, "Laptop", "en");
    expect(subscribe.mock.calls[0]![0].applicationServerKey).toEqual(
      Uint8Array.from([4, 5, 6]),
    );
    expect(sentCommand(0)).toMatchObject({
      kind: "enable",
      label: "Laptop",
      expectedRevision: 7,
    });
  });
  it("never adopts a subscription this binding does not own, nor another account's binding", async () => {
    getSubscription.mockResolvedValue(subscription);
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({
      uiMessage: { key: "notifications.orphanedSubscription" },
    });
    bind({ accountId: "another-account" });
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({
      uiMessage: { key: "notifications.otherAccount" },
    });
    expect(api.command).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
  it("a tab with a stale view cannot replace an enrollment the actor still lists", async () => {
    // This tab last saw no devices; a sibling tab enrolled since.
    bind({ subscriptionVersion: null });
    getSubscription.mockResolvedValue(subscription);
    api.state.mockResolvedValue(enrolled);
    await expect(enableNotifications(guard, "Laptop", "en")).resolves.toBe(
      enrolled,
    );
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(api.command).not.toHaveBeenCalled();
    expect(readEnrollment()?.deviceId).toBe(deviceId);
  });
  it("persists an ambiguous enable and retries exactly the same command without subscribing again", async () => {
    api.command.mockRejectedValueOnce(new Error("Response lost"));
    await expect(enableNotifications(guard, "Laptop", "en")).rejects.toThrow(
      "Response lost",
    );
    const command = sentCommand(0);
    expect(readEnrollment()?.pending).toEqual(command);
    getSubscription.mockResolvedValue(subscription);
    api.state.mockResolvedValue({ ...state, revision: 9 });
    await enableNotifications(guard, "Laptop", "en");
    expect(sentCommand(1)).toEqual(command);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(readEnrollment()?.pending).toBeNull();
  });
  it("a retried enable carries the name typed since, under a new command identity", async () => {
    api.command.mockRejectedValueOnce(new Error("Response lost"));
    await expect(enableNotifications(guard, "Laptop", "en")).rejects.toThrow(
      "Response lost",
    );
    const lost = sentCommand(0);
    const bound = readEnrollment()?.deviceId;
    getSubscription.mockResolvedValue(subscription);
    api.state.mockResolvedValue({ ...state, revision: 9 });
    const result = await enableNotifications(guard, "Desk", "en");
    const retried = sentCommand(1);
    expect(retried).toMatchObject({
      kind: "enable",
      deviceId: bound,
      label: "Desk",
      expectedRevision: 9,
    });
    expect(retried.commandId).not.toBe(lost.commandId);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(result.devices[0]?.label).toBe("Desk");
    expect(readEnrollment()).toMatchObject({
      deviceId: bound,
      subscriptionVersion: 1,
      pending: null,
    });
  });
  it("releases a definitively stale enable so a new explicit action can recover", async () => {
    api.command.mockRejectedValueOnce(new ApiError("stale_revision"));
    await expect(
      enableNotifications(guard, "Laptop", "en"),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const oldCommand = sentCommand(0);
    expect(readEnrollment()?.pending).toBeNull();
    getSubscription.mockResolvedValue(subscription);
    api.state.mockResolvedValue({ ...state, revision: 2 });
    await enableNotifications(guard, "Laptop", "en");
    const replacement = sentCommand(1);
    expect(replacement.commandId).not.toBe(oldCommand.commandId);
    expect(replacement.expectedRevision).toBe(2);
  });
  it("removes a listed device with the version the actor reports now", async () => {
    bind();
    getSubscription.mockResolvedValue(subscription);
    api.state.mockResolvedValue(enrolled);
    await removeNotifications(guard, deviceId);
    expect(sentCommand(0)).toMatchObject({
      kind: "remove",
      deviceId,
      subscriptionVersion: 3,
      expectedRevision: 4,
    });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(readEnrollment()).toBeNull();
  });
  it("a device the actor no longer lists gets local cleanup only", async () => {
    bind();
    getSubscription.mockResolvedValue(subscription);
    await expect(removeNotifications(guard, deviceId)).resolves.toBe(state);
    expect(api.command).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(readEnrollment()).toBeNull();
  });
  it("device removal only unsubscribes the captured endpoint, never its browser replacement", async () => {
    bind();
    const replacement = {
      ...subscription,
      endpoint: `${endpoint}-replacement`,
      unsubscribe: vi.fn(async () => true),
    };
    getSubscription.mockResolvedValue(replacement);
    await removeNotifications(guard, deviceId);
    expect(replacement.unsubscribe).not.toHaveBeenCalled();
    expect(readEnrollment()).toBeNull();
  });
  it("reads this browser's subscription endpoint only with an active worker", async () => {
    await expect(readBrowserSubscription()).resolves.toBeNull();
    getSubscription.mockResolvedValue(subscription);
    await expect(readBrowserSubscription()).resolves.toEqual({ endpoint });
    getRegistration.mockResolvedValueOnce({
      active: null,
      pushManager: { getSubscription, subscribe },
    } as never);
    await expect(readBrowserSubscription()).resolves.toBeNull();
  });
  it("releases an orphaned subscription and clears this account's dead binding", async () => {
    getSubscription.mockResolvedValue(subscription);
    await releaseOrphanedSubscription(guard);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    bind({ endpoint: `${endpoint}-earlier` });
    await releaseOrphanedSubscription(guard);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(2);
    expect(readEnrollment()).toBeNull();
  });
  it("orphan release leaves an owned subscription and another account's binding alone", async () => {
    bind();
    getSubscription.mockResolvedValue(subscription);
    await releaseOrphanedSubscription(guard);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(readEnrollment()?.deviceId).toBe(deviceId);
    bind({ accountId: "another-account", endpoint: `${endpoint}-theirs` });
    await expect(releaseOrphanedSubscription(guard)).rejects.toMatchObject({
      uiMessage: { key: "notifications.otherAccount" },
    });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(readEnrollment()?.accountId).toBe("another-account");
  });
  it("logout starts bounded-purpose cleanup without awaiting authentication and retains a failed-cleanup notice", async () => {
    bind();
    getSubscription.mockResolvedValue(subscription);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Offline");
      }),
    );
    expect(cleanupNotificationsOnLogout(accountId)).toBeUndefined();
    await vi.waitFor(() =>
      expect(subscription.unsubscribe).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(cleanupFailed()).toBe(true));
    expect(readEnrollment()?.accountId).toBe(accountId);
  });
  it("logout cleanup is not a failure while it runs, nor after it succeeds", async () => {
    bind();
    getSubscription.mockResolvedValue(subscription);
    let finish!: (value: { json: () => unknown }) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (finish = resolve))),
    );
    const observed: boolean[] = [];
    const unsubscribeStore = subscribeEnrollment(() =>
      observed.push(cleanupFailed()),
    );
    cleanupNotificationsOnLogout(accountId);
    await vi.waitFor(() => expect(readEnrollment()?.cleanupFailed).toBe(true));
    const started = observed.length;
    expect(started).toBeGreaterThan(0);
    expect(cleanupFailed()).toBe(false);
    finish({ json: () => ({ kind: "notification_state", state }) });
    await vi.waitFor(() => expect(readEnrollment()).toBeNull());
    await vi.waitFor(() => expect(observed.length).toBeGreaterThan(started));
    expect(cleanupFailed()).toBe(false);
    expect(observed).not.toContain(true);
    unsubscribeStore();
  });
  it("clears the binding when the captured subscription is already deactivated", async () => {
    bind();
    // The captured subscription deactivates before unsubscribe; later lookups return null.
    getSubscription.mockResolvedValueOnce(subscription);
    subscription.unsubscribe.mockResolvedValueOnce(false);
    await expect(removeNotifications(guard, deviceId)).resolves.toBe(state);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    await expect(readBrowserSubscription()).resolves.toBeNull();
    expect(readEnrollment()).toBeNull();
    expect(cleanupFailed()).toBe(false);
  });
  it("keeps a visible cleanup obligation when browser unsubscribe rejects", async () => {
    bind();
    getSubscription.mockResolvedValue(subscription);
    const error = new DOMException("Push service unavailable", "AbortError");
    subscription.unsubscribe.mockRejectedValueOnce(error);
    await expect(removeNotifications(guard, deviceId)).rejects.toBe(error);
    expect(cleanupFailed()).toBe(true);
    expect(readEnrollment()?.deviceId).toBe(deviceId);
  });
  it("a stale remove completion cannot restore the retired account's binding", async () => {
    bind();
    getSubscription.mockImplementationOnce(async () => {
      current.mockReturnValue(false);
      bind({
        accountId: "replacement",
        deviceId: "c1a3e8d4-0d64-4883-ab77-516fb425e48e",
      });
      return subscription;
    });
    await expect(removeNotifications(guard, deviceId)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(readEnrollment()?.accountId).toBe("replacement");
    expect(cleanupFailed()).toBe(false);
  });
});
