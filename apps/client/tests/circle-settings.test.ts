import { describe, expect, it } from "vitest";
import {
  inviteState,
  reorder,
  roleMessage,
  roleOrder,
} from "@/client/features/workspace/circle-settings/model";
import { message } from "@/client/features/i18n/messages";

describe("circle settings decisions", () => {
  it("moves one entry without disturbing the rest and ignores impossible moves", () => {
    const list = ["a", "b", "c", "d"];
    expect(reorder(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
    for (const [from, to] of [
      [1, 1],
      [-1, 2],
      [0, -1],
      [4, 0],
      [0, 4],
    ] as const)
      expect(reorder(list, from, to)).toEqual(list);
    expect(reorder(list, 0, 2)).not.toBe(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("reads an invitation as revoked, then spent, then out of time", () => {
    const now = 1_000;
    const invite = { revoked: false, uses: 0, maxUses: 3, expiresAt: 2_000 };
    expect(inviteState(invite, now)).toBe("active");
    expect(inviteState({ ...invite, uses: 2 }, now)).toBe("active");
    expect(inviteState({ ...invite, uses: 3 }, now)).toBe("usedUp");
    expect(inviteState({ ...invite, uses: 4 }, now)).toBe("usedUp");
    expect(inviteState({ ...invite, expiresAt: now }, now)).toBe("expired");
    expect(inviteState({ ...invite, expiresAt: 999 }, now)).toBe("expired");
    expect(inviteState({ ...invite, revoked: true }, now)).toBe("revoked");
    // A closed invitation reports the decision that closed it first.
    expect(
      inviteState({ revoked: true, uses: 3, maxUses: 3, expiresAt: 999 }, now),
    ).toBe("revoked");
    expect(
      inviteState({ revoked: false, uses: 3, maxUses: 3, expiresAt: 999 }, now),
    ).toBe("usedUp");
  });

  it("labels every role and orders the list by authority", () => {
    expect(roleMessage("owner")).toEqual(message("workspace.ownerRole"));
    expect(roleMessage("moderator")).toEqual(
      message("workspace.moderatorRole"),
    );
    expect(roleMessage("member")).toEqual(message("workspace.memberRole"));
    expect(
      (["member", "owner", "moderator"] as const)
        .toSorted((a, b) => roleOrder[a] - roleOrder[b])
        .join(),
    ).toBe("owner,moderator,member");
  });
});
