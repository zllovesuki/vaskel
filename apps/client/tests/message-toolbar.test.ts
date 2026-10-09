import { describe, expect, it } from "vitest";
import {
  messageActionIds,
  messageToolbarIds,
  timelineIntroPlacement,
  type HistoryPaging,
} from "@/client/features/chat/timeline-surface";

describe("message row commands", () => {
  it("keeps every available command in the menu while the toolbar shows conveniences", () => {
    const own = {
      react: true,
      reply: true,
      forward: true,
      copyLink: true,
      edit: true,
      remove: true,
    };
    expect(messageActionIds(own)).toEqual([
      "react",
      "reply",
      "forward",
      "copy-link",
      "edit",
      "delete",
    ]);
    // Reacting leads the toolbar; the link and destructive commands stay in
    // the menu, which is also the only reaction entry a touch reader gets.
    expect(messageToolbarIds(own)).toEqual(["react", "reply", "forward"]);
    // Someone else's message: authoring commands never reach either surface,
    // but reacting and copying a link do.
    const other = { react: true, reply: true, forward: true, copyLink: true };
    expect(messageActionIds(other)).toEqual([
      "react",
      "reply",
      "forward",
      "copy-link",
    ]);
    expect(messageToolbarIds(other)).toEqual(["react", "reply", "forward"]);
    // A mounted forward composer withdraws forwarding; replying stays.
    expect(messageActionIds({ reply: true, edit: true, remove: true })).toEqual(
      ["reply", "edit", "delete"],
    );
    expect(
      messageToolbarIds({ reply: true, edit: true, remove: true }),
    ).toEqual(["reply"]);
    // Offline or blocked quoting leaves only the menu commands; a deleted or
    // read-only row offers nothing at all, reactions included.
    expect(messageActionIds({ edit: true, remove: true })).toEqual([
      "edit",
      "delete",
    ]);
    expect(messageToolbarIds({ edit: true, remove: true })).toEqual([]);
    expect(messageActionIds({})).toEqual([]);
    expect(messageToolbarIds({})).toEqual([]);
  });
});

describe("start-of-history intro", () => {
  const intro = { kind: "room", name: "general" } as const;
  const earlier: HistoryPaging = {
    pending: false,
    disabled: false,
    load: () => {},
  };

  it("introduces the room only when no earlier page remains", () => {
    expect(
      timelineIntroPlacement({
        intro,
        loadEarlier: undefined,
        messageCount: 3,
      }),
    ).toBe("leading");
    expect(
      timelineIntroPlacement({
        intro,
        loadEarlier: earlier,
        messageCount: 3,
      }),
    ).toBe("none");
    // A pending or disabled control still means earlier history exists.
    expect(
      timelineIntroPlacement({
        intro,
        loadEarlier: { ...earlier, pending: true, disabled: true },
        messageCount: 3,
      }),
    ).toBe("none");
  });

  it("carries the empty transcript and needs a named place", () => {
    expect(
      timelineIntroPlacement({
        intro,
        loadEarlier: undefined,
        messageCount: 0,
      }),
    ).toBe("empty");
    expect(
      timelineIntroPlacement({
        intro: undefined,
        loadEarlier: undefined,
        messageCount: 0,
      }),
    ).toBe("none");
    expect(
      timelineIntroPlacement({
        intro: undefined,
        loadEarlier: undefined,
        messageCount: 3,
      }),
    ).toBe("none");
  });
});
