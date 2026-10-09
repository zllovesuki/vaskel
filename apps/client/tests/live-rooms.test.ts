import { describe, expect, it } from "vitest";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import {
  elapsedSince,
  liveRooms,
} from "@/client/features/workspace/live-rooms";

const circle: ResourceSummary = {
  owner: { kind: "server", id: "circle" },
  name: "Weekend regulars",
  version: 1,
  role: "owner",
  channels: [
    {
      id: "general",
      name: "general",
      kind: "text",
      private: false,
      version: 1,
      topic: null,
      position: 0,
      occupancy: null,
    },
    {
      id: "lounge",
      name: "Lounge",
      kind: "media",
      private: false,
      version: 1,
      topic: null,
      position: 1,
      occupancy: {
        revision: 3,
        participantIds: ["a", "b"],
        startedAt: 1_000,
        sharingUserIds: ["b"],
      },
    },
    {
      id: "quiet",
      name: "Quiet room",
      kind: "media",
      private: false,
      version: 1,
      topic: null,
      position: 2,
      occupancy: {
        revision: 1,
        participantIds: [],
        startedAt: null,
        sharingUserIds: [],
      },
    },
  ],
};

describe("live rooms", () => {
  it("lists occupied voice rooms with their circle and moderation right", () => {
    expect(liveRooms([circle])).toEqual([
      expect.objectContaining({
        channelId: "lounge",
        roomName: "Lounge",
        circleName: "Weekend regulars",
        canModerate: true,
      }),
    ]);
    expect(liveRooms([{ ...circle, role: "member" }])[0]?.canModerate).toBe(
      false,
    );
  });
  it("formats elapsed time", () => {
    expect(elapsedSince(null, 5_000)).toBe("");
    expect(elapsedSince(0, 65_000)).toBe("1:05");
    expect(elapsedSince(0, 3_725_000)).toBe("1:02:05");
  });
});
