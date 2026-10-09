import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallState } from "@/client/features/media/controller/state";
import { createI18n } from "@/client/features/i18n/render";
import { I18nProvider } from "@lingui/react";
import { NowPlayingBar } from "@/client/features/media/now-playing-bar";
import { DirectCallPanel } from "@/client/features/media/direct-call-panel";
import { JoinCallButton } from "@/client/features/media/room-panel";

// The join surfaces reach `@/client/api/client`, which reads the page origin
// while the module loads; this node environment has no window before imports.
vi.hoisted(() =>
  Object.assign(globalThis, {
    window: { location: { origin: "https://vaskel.test" } },
  }),
);

const fixture = vi.hoisted(() => ({
  state: {} as CallState,
  stageVisible: false,
  pathname: "/servers/circle/channels/voice",
  isOperator: false,
}));
vi.mock("@/client/features/auth/session-state", () => ({
  useUser: () => ({ userId: "self", isOperator: fixture.isOperator }),
}));
vi.mock("@/client/features/media/context", () => ({
  useMedia: () => ({ state: fixture.state, controller: {} }),
  useMediaStage: () => ({ visible: fixture.stageVisible, ref: () => {} }),
}));
vi.mock("@/client/features/cache/access/context", () => ({
  useAccess: () => ({ canUseNetwork: true }),
}));
vi.mock("@/client/features/media/call-hooks", () => ({
  useCallDuration: () => "00:42",
  useParticipantNames: () => new Map(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: fixture.pathname }),
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
}));

function render(node: ReactNode, language: "en" | "ja" = "en") {
  return renderToStaticMarkup(
    createElement(I18nProvider, { i18n: createI18n(language).runtime }, node),
  );
}

function markup() {
  return render(createElement(NowPlayingBar));
}

const directRoom = {
  owner: { kind: "conversation", id: "dm" },
  channelId: "dm",
} as const;

beforeEach(() => {
  fixture.stageVisible = false;
  fixture.isOperator = false;
  fixture.pathname = "/servers/circle/channels/voice";
  fixture.state = {
    phase: "joining",
    configured: true,
    room: { owner: { kind: "server", id: "circle" }, channelId: "voice" },
    label: "Lounge",
    canModerate: false,
    session: null,
    muted: false,
    pendingSources: [],
    error: null,
    transfer: null,
    playbackBlocked: false,
    hiddenUserIds: [],
    joinedAt: null,
    deafened: false,
    pictureInPicture: true,
  };
});

describe("persistent call controls", () => {
  it("offers Leave during a pending join on the same room route", () => {
    const html = markup();
    expect(html).toContain("Joining call…");
    expect(html).toContain("Leave");
  });

  it("keeps failure feedback, Reconnect and Leave when the stage is gone", () => {
    fixture.state.phase = "error";
    fixture.state.error = { key: "media.reconnectingNotice" };
    const html = markup();
    expect(html).toContain("Reconnecting to the call…");
    expect(html).toContain("Reconnect</button>");
    expect(html).toContain("Leave");
  });

  it("keeps DM controls while its stage is folded and yields only to a visible stage", () => {
    fixture.state.phase = "active";
    fixture.state.room = {
      owner: { kind: "conversation", id: "dm" },
      channelId: "dm",
    };
    fixture.pathname = "/conversations/dm";
    const html = markup();
    expect(html).toContain('title="Mute"');
    expect(html).toContain("Leave");
    fixture.stageVisible = true;
    expect(markup()).toBe("");
  });

  it("keeps explicit transfer confirmation beside a visible stage without duplicating controls", () => {
    fixture.state.phase = "active";
    fixture.stageVisible = true;
    fixture.state.transfer = {
      room: {
        owner: { kind: "server", id: "circle" },
        channelId: "other-voice",
      },
      label: "Quiet room",
      canModerate: false,
      generation: 1,
    };
    const html = markup();
    expect(html).toContain("Move call");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Leave");
    expect(html).not.toContain('title="Mute"');
  });
});

describe("calls that are not set up", () => {
  beforeEach(() => {
    fixture.state.phase = "idle";
    fixture.state.room = null;
    fixture.state.configured = false;
  });

  it("explains the off Join in a direct message and links the two", () => {
    const panel = render(
      createElement(DirectCallPanel, { room: directRoom, title: "李婷" }),
    );
    expect(panel).toContain("been set up on this vaskel.");
    expect(panel).toContain('id="call-setup-notice"');
    const button = render(
      createElement(JoinCallButton, { room: directRoom, label: "李婷" }),
    );
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-describedby="call-setup-notice"');
  });

  it("gives the host the setup path a member cannot act on", () => {
    const member = render(
      createElement(DirectCallPanel, { room: directRoom, title: "李婷" }),
    );
    expect(member).not.toContain("REALTIME_APP_ID");
    fixture.isOperator = true;
    const host = render(
      createElement(DirectCallPanel, { room: directRoom, title: "李婷" }),
    );
    expect(host).toContain("been set up on this vaskel.");
    expect(host).toContain("REALTIME_APP_ID");
    expect(host).toContain("REALTIME_APP_SECRET");
    const japanese = render(
      createElement(DirectCallPanel, { room: directRoom, title: "李婷" }),
      "ja",
    );
    expect(japanese).toContain("この vaskel. 用の Realtime");
  });

  it("leaves a direct message alone once calls are available", () => {
    fixture.state.configured = true;
    expect(
      render(
        createElement(DirectCallPanel, { room: directRoom, title: "李婷" }),
      ),
    ).toBe("");
    const button = render(
      createElement(JoinCallButton, { room: directRoom, label: "李婷" }),
    );
    expect(button).not.toContain("aria-describedby");
    expect(button).not.toContain('disabled=""');
  });
});
