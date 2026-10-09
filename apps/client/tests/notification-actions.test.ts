import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NotificationState } from "@vaskel/contracts/notifications";
import { useNotifications } from "@/client/features/notifications/use-notifications";

const actions = vi.hoisted(() => ({
  enable: vi.fn(),
  remove: vi.fn(),
  release: vi.fn(),
  command: vi.fn(),
}));
const account = vi.hoisted(() => ({ token: "first" }));
vi.mock("@/client/features/notifications/browser", () => ({
  enableNotifications: actions.enable,
  removeNotifications: actions.remove,
  releaseOrphanedSubscription: actions.release,
}));
vi.mock("@/client/api/notifications", () => ({
  notificationsKey: (accountId: string) => ["notifications", accountId],
  notificationsOptions: (accountId: string) => ({
    queryKey: ["notifications", accountId],
    queryFn: () => {
      throw new Error("Unexpected fetch");
    },
  }),
  notificationCommand: actions.command,
}));
vi.mock("@/client/features/auth/session-state", () => ({
  useUser: () => ({ userId: "account" }),
}));
vi.mock("@/client/features/cache/access/context", () => ({
  useAccess: () => ({
    canUseNetwork: true,
    accountToken: () => account.token,
    accountCurrent: (token: string) => token === account.token,
  }),
}));
const key = ["notifications", "account"];
const state: NotificationState = {
  accountId: "account",
  revision: 4,
  publicKey: "AQID",
  preferences: { paused: false, preview: "generic", language: "en" },
  devices: [],
  rooms: [],
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  account.token = "first";
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  client.setQueryData(key, state);
  actions.enable.mockResolvedValue(state);
  actions.remove.mockResolvedValue(state);
  actions.release.mockResolvedValue(undefined);
  actions.command.mockResolvedValue(state);
});
afterEach(() => client.clear());
function renderActions() {
  let result!: ReturnType<typeof useNotifications>;
  function Probe() {
    result = useNotifications();
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Probe)),
  );
  return result;
}
const mutation = () => client.getMutationCache().getAll().at(-1)!;

it("starts permission work synchronously and observes its result through Query", async () => {
  const notifications = renderActions();
  notifications.enable("Laptop", "ja");
  expect(actions.enable).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "account" }),
    "Laptop",
    "ja",
  );
  await vi.waitFor(() => expect(mutation().state.status).toBe("success"));
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

it.each(["removeThisDevice", "removeDevice", "releaseOrphan"] as const)(
  "rejects retired %s work before browser operations start",
  async (action) => {
    const notifications = renderActions();
    if (action === "releaseOrphan") notifications.releaseOrphan();
    else notifications[action]("device");
    account.token = "replacement";
    await vi.waitFor(() => expect(mutation().state.status).toBe("error"));
    expect(mutation().state.error).toMatchObject({ name: "AbortError" });
    expect(actions.remove).not.toHaveBeenCalled();
    expect(actions.release).not.toHaveBeenCalled();
  },
);

it("does not publish an action result after account retirement", async () => {
  let release!: (value: NotificationState) => void;
  actions.remove.mockImplementation(
    () =>
      new Promise<NotificationState>((resolve) => {
        release = resolve;
      }),
  );
  renderActions().removeDevice("remote-device");
  await vi.waitFor(() => expect(actions.remove).toHaveBeenCalledOnce());
  account.token = "replacement";
  client.removeQueries({ queryKey: key });
  release({ ...state, revision: 5 });
  await vi.waitFor(() => expect(mutation().state.status).toBe("error"));
  expect(mutation().state.error).toMatchObject({ name: "AbortError" });
  expect(client.getQueryData(key)).toBeUndefined();
});

it("captures settings identity and the accepted revision before dispatch", async () => {
  renderActions().change({
    kind: "preferences",
    ...state.preferences,
    paused: true,
  });
  client.setQueryData(key, { ...state, revision: 5 });
  await vi.waitFor(() => expect(actions.command).toHaveBeenCalledOnce());
  expect(actions.command).toHaveBeenCalledWith(
    "account",
    expect.objectContaining({
      kind: "preferences",
      paused: true,
      expectedRevision: 4,
      commandId: expect.any(String),
      issuedAt: expect.any(Number),
    }),
  );
  await vi.waitFor(() => expect(mutation().state.status).toBe("success"));
});
