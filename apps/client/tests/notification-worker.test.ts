import { describe, expect, it, vi } from "vitest";
import { NotificationPayloadSchema } from "@vaskel/contracts/notifications";
import {
  receiveNotification,
  openNotification,
} from "@/client/service-worker/notifications";
import {
  notificationReturnDecision,
  notificationReturnPath,
} from "@/client/routes/notification-target";

const accountId = "00000000-0000-4000-8000-000000000001";
const roomId = "00000000-0000-4000-8000-000000000002";
const target = { accountId, owner: { kind: "server", id: "circle" }, roomId };
const payload = NotificationPayloadSchema.parse({
  ...target,
  messageId: roomId,
  title: "vaskel.",
  body: "New activity",
  tag: "room",
});

describe("notification reception", () => {
  it.each([
    null,
    {
      json: () => {
        throw new SyntaxError("Invalid push");
      },
    },
    { json: () => ({ url: "https://hostile.test", unreadCount: 9000 }) },
  ])("shows a visible generic fallback for an unusable push", async (data) => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    await receiveNotification(data, { showNotification }, {});
    expect(showNotification).toHaveBeenCalledWith(
      "vaskel.",
      expect.objectContaining({
        body: "New activity on vaskel.",
        data: null,
      }),
    );
  });

  it("displays a validated preview and only an approximate dot", async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const setAppBadge = vi.fn().mockRejectedValue(new Error("Unsupported"));
    await receiveNotification(
      { json: () => payload },
      { showNotification },
      { setAppBadge },
    );
    expect(showNotification).toHaveBeenCalledWith(
      "vaskel.",
      expect.objectContaining({
        body: "New activity",
        tag: "room",
        data: target,
      }),
    );
    expect(setAppBadge).toHaveBeenCalledExactlyOnceWith();
  });
});

describe("notification return", () => {
  it("constructs encoded paths from identity instead of accepting arbitrary URLs", () => {
    expect(
      notificationReturnPath({
        ...target,
        owner: { kind: "server", id: "//hostile.test/a?b#c" },
      }),
    ).toBe(
      `/notifications/${accountId}/server/%2F%2Fhostile.test%2Fa%3Fb%23c/${roomId}`,
    );
    expect(notificationReturnPath({ url: "https://hostile.test" })).toBe("/");
    expect(notificationReturnPath({ ...target, owner: null })).toBe("/");
  });

  it("preserves intended account through sign-in and refuses a replacement account", () => {
    expect(notificationReturnDecision(target, null)).toEqual({
      kind: "sign-in",
    });
    expect(notificationReturnDecision(target, roomId)).toEqual({
      kind: "other-account",
    });
    expect(notificationReturnDecision(target, accountId)).toEqual({
      kind: "open",
      location: {
        to: "/servers/$serverId/channels/$channelId",
        params: { serverId: "circle", channelId: roomId },
      },
    });
  });

  it("uses normal conversation and Home routes without marking a message read", () => {
    expect(
      notificationReturnDecision(
        { ...target, owner: { kind: "conversation", id: "dm" } },
        accountId,
      ),
    ).toEqual({
      kind: "open",
      location: {
        to: "/conversations/$conversationId",
        params: { conversationId: "dm" },
      },
    });
    const testTarget = { accountId, owner: null, roomId: null };
    expect(notificationReturnPath(testTarget)).toBe(
      `/notifications/${accountId}`,
    );
    expect(notificationReturnDecision(testTarget, accountId)).toEqual({
      kind: "open",
      location: { to: "/" },
    });
  });

  it("focuses an existing return page but preserves unrelated tabs and calls", async () => {
    const origin = "https://vaskel.test";
    const url = origin + notificationReturnPath(target);
    const focus = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue(undefined);
    const matchAll = vi.fn().mockResolvedValue([{ url, focus }]);
    await openNotification(target, origin, { matchAll, openWindow });
    expect(focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
    matchAll.mockResolvedValue([
      { url: `${origin}/conversations/in-a-call`, focus },
    ]);
    await openNotification(target, origin, { matchAll, openWindow });
    expect(focus).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("recovers from a disappeared window and sends invalid targets to same-origin Home", async () => {
    const openWindow = vi.fn().mockResolvedValue(undefined);
    const matchAll = vi.fn().mockRejectedValue(new Error("Client gone"));
    await openNotification(
      { url: "javascript:alert(1)" },
      "https://vaskel.test",
      { matchAll, openWindow },
    );
    expect(openWindow).toHaveBeenCalledExactlyOnceWith("https://vaskel.test/");
  });
});
