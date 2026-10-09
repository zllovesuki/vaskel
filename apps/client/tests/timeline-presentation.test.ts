import { describe, expect, it, vi } from "vitest";
import { latestTimeline } from "@/client/features/chat/reconcile";
import {
  timelinePresentation,
  canInteractWithTimeline,
} from "@/client/features/chat/timeline-presentation";

const data = latestTimeline({
  messages: [],
  cursor: {
    owner: { kind: "server", id: "circle" },
    channelId: "room",
    generation: "generation",
    sequence: 1,
  },
  nextBefore: null,
  readSequence: 0,
});
const accepted = {
  data,
  status: "success" as const,
  fetchStatus: "idle" as const,
  error: null,
};
const access = { canUseNetwork: true, denial: null, historyHidden: false };
const retry = vi.fn(async () => undefined);

describe("timeline presentation invariants", () => {
  it("denial with retained Query data exposes neither history nor recovery", () => {
    const view = timelinePresentation(
      accepted,
      { ...access, denial: "forbidden" },
      retry,
    );
    expect(view).toEqual({ kind: "denied", reason: "forbidden" });
    expect(canInteractWithTimeline(view)).toBe(false);
  });

  it("a failed refresh retains its transcript and supplies local recovery", async () => {
    const error = new Error("Connection reset");
    const view = timelinePresentation(
      { ...accepted, status: "error", error },
      access,
      retry,
    );
    expect(view).toEqual({
      kind: "conversation",
      read: {
        kind: "visible",
        data,
        interaction: { kind: "failed", error, retry },
      },
    });
    expect(canInteractWithTimeline(view)).toBe(false);
    if (view.kind !== "conversation" || view.read.interaction.kind !== "failed")
      throw new Error("Missing recovery");
    await view.read.interaction.retry();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("an active retry with a retained error is checking, not a stopped failure", () => {
    const query = {
      ...accepted,
      status: "error" as const,
      fetchStatus: "fetching" as const,
      error: new Error("Previous failure"),
    };
    const view = timelinePresentation(query, access, retry);
    expect(view).toEqual({
      kind: "conversation",
      read: { kind: "visible", data, interaction: { kind: "checking" } },
    });
    expect(canInteractWithTimeline(view)).toBe(false);
    expect(
      timelinePresentation({ ...query, data: undefined }, access, retry),
    ).toEqual({ kind: "loading" });
  });

  it("retirement withholds transcript data while preserving the conversation lifetime", () => {
    const hidden = { ...access, historyHidden: true };
    const view = timelinePresentation(accepted, hidden, retry);
    expect(view).toEqual({
      kind: "conversation",
      read: { kind: "withheld", interaction: { kind: "checking" } },
    });
    expect(canInteractWithTimeline(view)).toBe(false);
    const error = new Error("Read unavailable");
    expect(
      timelinePresentation(
        { ...accepted, status: "error", error },
        hidden,
        retry,
      ),
    ).toEqual({
      kind: "conversation",
      read: { kind: "withheld", interaction: { kind: "failed", error, retry } },
    });
  });

  it("offline admission preserves accepted content without granting interaction", () => {
    const offline = { ...access, canUseNetwork: false };
    const view = timelinePresentation(accepted, offline, retry);
    expect(view).toEqual({
      kind: "conversation",
      read: { kind: "visible", data, interaction: { kind: "offline" } },
    });
    expect(canInteractWithTimeline(view)).toBe(false);
    const error = new Error("Initial failure");
    expect(
      timelinePresentation(
        { data: undefined, status: "error", fetchStatus: "idle", error },
        offline,
        retry,
      ),
    ).toEqual({ kind: "failed", error, retry: null });
  });

  it("only an accepted visible result admits conversation actions", () => {
    const pending = timelinePresentation(
      {
        data: undefined,
        status: "pending",
        fetchStatus: "fetching",
        error: null,
      },
      access,
      retry,
    );
    expect(pending).toEqual({ kind: "loading" });
    expect(canInteractWithTimeline(pending)).toBe(false);
    expect(
      canInteractWithTimeline(timelinePresentation(accepted, access, retry)),
    ).toBe(true);
  });
});
