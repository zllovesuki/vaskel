import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { routeTree } from "@/client/router-config";
import { applicationRouteTemplates } from "@/client/routes/application-paths";
import { resourceLocation } from "@/client/routes/resource-location";
import { selectResource } from "@/client/features/workspace/resource-selection";
import {
  defaultDestination,
  roomDestination,
} from "@/client/features/workspace/destination";
import type { ResourceSummary } from "@vaskel/contracts/directory";

// Exercise the real route tree without mounting authenticated UI or browser APIs.
vi.mock("@/client/routes/root-layout", () => ({ RootLayout: () => null }));
vi.mock("@/client/routes/entry-screen", () => ({ EntryScreen: () => null }));
vi.mock("@/client/routes/notification-return", () => ({
  NotificationReturn: () => null,
}));
vi.mock("@/client/features/auth/sign-in", () => ({ SignInPage: () => null }));

function routingAt(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return createRouter({
    routeTree,
    history,
    isServer: false,
    origin: "http://localhost",
  });
}

const server: ResourceSummary = {
  owner: { kind: "server", id: "server-a" },
  name: "Server",
  version: 1,
  role: "member",
  channels: [
    {
      id: "allowed-channel",
      name: "General",
      kind: "text",
      private: false,
      version: 1,
      topic: null,
      occupancy: null,
      position: 0,
    },
    {
      id: "voice-channel",
      name: "Voice",
      kind: "media",
      private: false,
      version: 1,
      topic: null,
      occupancy: null,
      position: 1,
    },
  ],
};
const conversation: ResourceSummary = {
  ...server,
  owner: { kind: "conversation", id: "conversation-b" },
  participantIds: ["me", "them"],
  channels: [
    {
      id: "dm-channel",
      name: "DM",
      kind: "text",
      private: true,
      version: 1,
      topic: null,
      occupancy: null,
      position: 0,
    },
  ],
};

describe("resource paths", () => {
  it("opens Notifications as an independent workspace settings route", async () => {
    const router = routingAt("/settings/notifications");
    await router.load();
    expect(router.state.matches.at(-1)).toMatchObject({
      status: "success",
      routeId: "/_workspace/settings/notifications",
      staticData: { page: "notifications" },
      params: {},
    });
    expect(router.state.location.pathname).toBe("/settings/notifications");
  });
  it("keeps the intended notification account and destination in the shell route", async () => {
    const accountId = "00000000-0000-4000-8000-000000000001";
    const channelId = "00000000-0000-4000-8000-000000000002";
    const router = routingAt(
      `/notifications/${accountId}/server/circle/${channelId}`,
    );
    await router.load();
    expect(router.state.matches.at(-1)).toMatchObject({
      status: "success",
      params: { accountId, ownerKind: "server", ownerId: "circle", channelId },
      staticData: { page: "notificationReturn" },
    });
  });
  it("loads a direct channel path and keeps search as a filter", async () => {
    const router = routingAt(
      "/servers/server-a/channels/voice-channel?q=hello",
    );
    await router.load();
    const match = router.state.matches.at(-1);
    expect(match?.routeId).toBe(
      "/_workspace/servers/$serverId/channels/$channelId",
    );
    expect(match?.params).toMatchObject({
      serverId: "server-a",
      channelId: "voice-channel",
    });
    expect(match?.search).toEqual({ q: "hello" });
    expect(match?.status).toBe("success");
    expect(
      Object.values(router.routesById)
        .filter((route) => !route.children?.length)
        .map((route) =>
          route.fullPath === "/" ? "/" : route.fullPath.replace(/\/$/, ""),
        )
        .sort(),
    ).toEqual([...applicationRouteTemplates].sort());
  });

  it("loads global search filters without reinterpreting them as a channel route", async () => {
    const serverId = "00000000-0000-4000-8000-000000000001";
    const router = routingAt(
      `/search?q=hello&server=${serverId}&channel=general`,
    );
    await router.load();
    expect(router.state.matches.at(-1)).toMatchObject({
      routeId: "/_workspace/search",
      status: "success",
      params: {},
      search: { q: "hello", server: serverId, channel: "general" },
    });
    expect(router.state.location.pathname).toBe("/search");
    await router.navigate({
      ...resourceLocation(server.owner, "allowed-channel"),
      search: { q: "local query" },
    });
    await router.load();
    expect(router.state.matches.at(-1)?.search).toEqual({ q: "local query" });
    expect(router.state.location.pathname).toBe(
      "/servers/server-a/channels/allowed-channel",
    );
  });

  it.each(["server=invalid", "channel=general", "q=" + "x".repeat(257)])(
    "rejects invalid global search filters %s without a redirect",
    async (filters) => {
      const router = routingAt(`/search?${filters}`);
      await router.load();
      expect(router.state.matches.at(-1)?.status).toBe("error");
      expect(router.state.location.pathname).toBe("/search");
    },
  );

  it("drops malformed root search values instead of failing the page", async () => {
    const entry = routingAt("/sign-in?at=not-a-number&q=2024&token=null");
    await entry.load();
    expect(entry.state.matches.at(-1)).toMatchObject({
      routeId: "/sign-in",
      status: "success",
    });
    expect(entry.state.matches.at(-1)?.search).toEqual({});
    const room = routingAt(
      "/servers/server-a/channels/allowed-channel?q=hello&at=12",
    );
    await room.load();
    expect(room.state.matches.at(-1)?.search).toEqual({ q: "hello", at: 12 });
  });

  it("keeps resource identity across navigation, back and forward", async () => {
    const router = routingAt("/servers/server-a/channels/allowed-channel");
    await router.load();
    await router.navigate({
      ...resourceLocation(conversation.owner, "dm-channel"),
      search: {},
    });
    await router.load();
    expect(router.state.location.pathname).toBe(
      "/conversations/conversation-b",
    );
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      conversationId: "conversation-b",
    });
    router.history.back();
    await router.load();
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      serverId: "server-a",
      channelId: "allowed-channel",
    });
    router.history.forward();
    await router.load();
    expect(router.state.location.pathname).toBe(
      "/conversations/conversation-b",
    );
  });

  it("navigates to blocked people and back without changing the root route", async () => {
    const router = routingAt("/conversations/conversation-b");
    await router.load();
    const rootMatch = router.state.matches[0]?.id;
    await router.navigate({ to: "/settings/blocked", search: {} });
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(
      "/_workspace/settings/blocked",
    );
    expect(router.state.matches[0]?.id).toBe(rootMatch);
    expect(router.state.matches.at(-1)?.params).toEqual({});
    await router.navigate({ to: "/settings/account", search: {} });
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(
      "/_workspace/settings/account",
    );
    expect(router.state.matches[0]?.id).toBe(rootMatch);
    router.history.back();
    await router.load();
    router.history.back();
    await router.load();
    expect(router.state.location.pathname).toBe(
      "/conversations/conversation-b",
    );
  });

  it("encodes resource parameters without treating them as URL syntax", () => {
    const router = routingAt("/");
    const location = router.buildLocation({
      ...resourceLocation({ kind: "server", id: "a/b" }, "c?d"),
      search: {},
    });
    expect(location.href).toBe("/servers/a%2Fb/channels/c%3Fd");
  });

  it.each([
    "/sign-in",
    "/bootstrap",
    "/invite",
    "/verify-email",
    "/reset-password",
    "/forgot-password",
  ])("loads %s without reinterpreting one-time tokens", async (path) => {
    const router = routingAt(`${path}?token=one%2Btime%2Fvalue`);
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(path);
    expect(router.state.matches.at(-1)?.search).toEqual({
      token: "one+time/value",
    });
    expect(router.state.location.pathname).toBe(path);
  });

  it("resolves a server index only to a channel returned in its authorized directory", async () => {
    const router = routingAt("/servers/server-a");
    await router.load();
    expect(router.state.matches.at(-1)?.routeId).toBe(
      "/_workspace/servers/$serverId/",
    );
    const selection = selectResource([server, conversation], {
      serverId: "server-a",
    });
    expect(selection.channel?.id).toBe("allowed-channel");
    expect(resourceLocation(server.owner, selection.channel?.id)).toEqual({
      to: "/servers/$serverId/channels/$channelId",
      params: { serverId: "server-a", channelId: "allowed-channel" },
    });
  });

  it("does not fall back to another resource or channel after access changes", () => {
    expect(
      selectResource([server, conversation], { serverId: "missing-server" })
        .resource,
    ).toBeUndefined();
    expect(
      selectResource([server, conversation], {
        serverId: "server-a",
        channelId: "revoked-channel",
      }).channel,
    ).toBeUndefined();
    expect(
      selectResource([server, conversation], { conversationId: "server-a" })
        .resource,
    ).toBeUndefined();
  });

  it("resolves the DM channel from directory state instead of assuming it equals its owner", () => {
    expect(
      selectResource([server, conversation], {
        conversationId: "conversation-b",
      }).channel?.id,
    ).toBe("dm-channel");
  });

  it("skips resources with no accessible channels for the workspace index", () => {
    expect(
      selectResource([{ ...server, channels: [] }, conversation], {}).resource,
    ).toBe(conversation);
  });
});

describe("remembered place", () => {
  it("returns to the remembered place when nothing is requested and it is still listed", () => {
    const selection = selectResource(
      [server, conversation],
      {},
      {
        owner: conversation.owner,
        channelId: "dm-channel",
      },
    );
    expect(selection.requested).toBe(false);
    expect(selection.resource).toBe(conversation);
    expect(selection.channel?.id).toBe("dm-channel");
  });

  it("falls back to the default when the remembered place left the directory", () => {
    expect(
      selectResource(
        [server, conversation],
        {},
        {
          owner: { kind: "server", id: "gone" },
          channelId: "allowed-channel",
        },
      ).resource,
    ).toBe(server);
    const revoked = selectResource(
      [server, conversation],
      {},
      {
        owner: server.owner,
        channelId: "revoked-channel",
      },
    );
    expect(revoked.resource).toBe(server);
    expect(revoked.channel?.id).toBe("allowed-channel");
  });

  it("never lets a remembered place override a requested one", () => {
    const selection = selectResource(
      [server, conversation],
      { serverId: "server-a" },
      { owner: conversation.owner, channelId: "dm-channel" },
    );
    expect(selection.resource).toBe(server);
    expect(selection.channel?.id).toBe("allowed-channel");
  });

  it("stores and validates the place per account on this device", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    const { readRememberedPlace, rememberPlace } =
      await import("@/client/features/workspace/resource-selection");
    expect(readRememberedPlace("me")).toBeNull();
    rememberPlace("me", { owner: server.owner, channelId: "allowed-channel" });
    expect(readRememberedPlace("me")).toEqual({
      owner: { kind: "server", id: "server-a" },
      channelId: "allowed-channel",
    });
    expect(readRememberedPlace("someone-else")).toBeNull();
    store.set("vaskel.place:me", '{"owner":{"kind":"group","id":1}}');
    expect(readRememberedPlace("me")).toBeNull();
    store.set("vaskel.place:me", "not json");
    expect(readRememberedPlace("me")).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage unavailable");
      },
      setItem: () => {
        throw new Error("Storage unavailable");
      },
    });
    expect(() =>
      rememberPlace("me", {
        owner: server.owner,
        channelId: "allowed-channel",
      }),
    ).not.toThrow();
    expect(readRememberedPlace("me")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("destination outcomes", () => {
  const refetch = async () => undefined;
  const directory = {
    isPending: false,
    error: null,
    refetch,
    hasNextPage: false,
    partial: false,
    pageCount: 1,
  };

  it("stops default pagination on failure even when its next cursor remains", () => {
    const error = new Error("next page failed");
    expect(
      defaultDestination([], null, { ...directory, error, hasNextPage: true }),
    ).toEqual({ kind: "error", error, retry: refetch });
    expect(
      defaultDestination([], null, { ...directory, hasNextPage: true }),
    ).toEqual({ kind: "discovering" });
  });

  it("distinguishes unavailable discovery from an exhausted index with no destination", () => {
    expect(
      defaultDestination([], null, { ...directory, partial: true }).kind,
    ).toBe("error");
    expect(defaultDestination([], null, directory)).toEqual({ kind: "empty" });
    expect(
      defaultDestination([], null, {
        ...directory,
        hasNextPage: true,
        pageCount: 21,
      }).kind,
    ).toBe("error");
  });

  it("redirects carry a complete target and room variants carry the matching channel", () => {
    expect(defaultDestination([server], null, directory)).toEqual({
      kind: "redirect",
      target: { owner: server.owner, channelId: "allowed-channel" },
    });
    expect(roomDestination(server, "voice-channel")).toMatchObject({
      kind: "media",
      resource: server,
      channel: { id: "voice-channel", kind: "media" },
    });
    expect(roomDestination(server, "allowed-channel")).toMatchObject({
      kind: "text",
      channel: { id: "allowed-channel", kind: "text" },
    });
    expect(roomDestination(server, "missing")).toEqual({
      kind: "missing-channel",
      owner: server.owner,
    });
    expect(roomDestination(conversation)).toMatchObject({
      kind: "text",
      channel: { id: "dm-channel" },
    });
  });
});
