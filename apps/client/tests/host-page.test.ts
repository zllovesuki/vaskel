import { describe, expect, it } from "vitest";
import {
  ICON_CONTENT_TYPES,
  iconFileProblem,
  isInstant,
  usageIncomplete,
  usagePercent,
  usageShare,
} from "@/client/features/host/host-model";
import { orderSessions } from "@/client/features/account/sessions";
import type { AccountSession } from "@vaskel/contracts/account";
import {
  INSTANCE_ICON_BYTE_LIMIT,
  OPERATOR_PAGE_LIMIT,
} from "@vaskel/contracts/instance";

const session = (
  id: string,
  createdAt: string,
  current = false,
): AccountSession => ({
  id,
  createdAt,
  userAgentFamily: "Firefox",
  current,
});

describe("host and account settings presentation", () => {
  it("admits only the raster types and sizes the instance actor accepts", () => {
    for (const type of ICON_CONTENT_TYPES)
      expect(iconFileProblem({ type, size: 1024 })).toBeNull();
    expect(
      iconFileProblem({ type: "IMAGE/PNG; charset=binary", size: 1024 }),
    ).toBeNull();
    expect(iconFileProblem({ type: "image/gif", size: 1024 })).toBe("type");
    expect(iconFileProblem({ type: "image/svg+xml", size: 1024 })).toBe("type");
    expect(iconFileProblem({ type: "", size: 1024 })).toBe("type");
    // An empty selection carries no signature, so it is refused as a type.
    expect(iconFileProblem({ type: "image/png", size: 0 })).toBe("type");
    expect(
      iconFileProblem({ type: "image/png", size: INSTANCE_ICON_BYTE_LIMIT }),
    ).toBeNull();
    expect(
      iconFileProblem({
        type: "image/png",
        size: INSTANCE_ICON_BYTE_LIMIT + 1,
      }),
    ).toBe("size");
    // A file larger than the limit is refused for its size, not its type.
    expect(
      iconFileProblem({
        type: "image/gif",
        size: INSTANCE_ICON_BYTE_LIMIT + 1,
      }),
    ).toBe("type");
  });

  it("keeps a usage bar inside its budget whatever the owner reports", () => {
    expect(usagePercent(0, 512)).toBe(0);
    expect(usagePercent(128, 512)).toBe(25);
    expect(usagePercent(512, 512)).toBe(100);
    // Charged bytes can exceed a lowered budget; the bar stops at full.
    expect(usagePercent(900, 512)).toBe(100);
    expect(usageShare(900, 512)).toBe(1);
    expect(usagePercent(-10, 512)).toBe(0);
    // A missing or zero budget cannot be divided into a share.
    expect(usagePercent(100, 0)).toBe(0);
    expect(usageShare(Number.NaN, 512)).toBe(0);
    expect(usageShare(100, Number.NaN)).toBe(0);
  });

  it("separates unread owners from a further page of usage", () => {
    const owners = (count: number) => Array.from({ length: count }, () => ({}));
    // A full page with a cursor only means more owners follow.
    expect(
      usageIncomplete({
        owners: owners(OPERATOR_PAGE_LIMIT),
        nextAfter: "8f3a1f4c-0000-4000-8000-000000000000",
        partial: true,
      }),
    ).toBe(false);
    // A short page with a cursor means owners on this page went unread.
    expect(
      usageIncomplete({
        owners: owners(OPERATOR_PAGE_LIMIT - 1),
        nextAfter: "8f3a1f4c-0000-4000-8000-000000000000",
        partial: true,
      }),
    ).toBe(true);
    // The last page marks itself partial only when an owner failed.
    expect(
      usageIncomplete({ owners: owners(3), nextAfter: null, partial: true }),
    ).toBe(true);
    expect(
      usageIncomplete({ owners: owners(3), nextAfter: null, partial: false }),
    ).toBe(false);
  });

  it("only sends a parsable created date to a locale formatter", () => {
    for (const value of [
      "2026-09-17T06:00:00.000Z",
      "2026-09-17 06:00:00",
      "2026-09-17",
    ])
      expect(isInstant(value)).toBe(true);
    // The contract types this column as a bare string; reject unparsable values.
    for (const value of ["", "not a date", "0000-00-00", "NaN"])
      expect(isInstant(value)).toBe(false);
  });

  it("puts this device first and orders the rest by sign-in time", () => {
    const rows = [
      session("33333333-0000-4000-8000-000000000000", "2026-09-10T08:00:00Z"),
      session("11111111-0000-4000-8000-000000000000", "2026-09-17T09:00:00Z"),
      session(
        "22222222-0000-4000-8000-000000000000",
        "2026-09-01T09:00:00Z",
        true,
      ),
    ];
    expect(orderSessions(rows).map((row) => row.id)).toEqual([
      "22222222-0000-4000-8000-000000000000",
      "11111111-0000-4000-8000-000000000000",
      "33333333-0000-4000-8000-000000000000",
    ]);
    // Equal and unreadable times keep a stable order instead of reshuffling.
    const tied = [
      session("bbbbbbbb-0000-4000-8000-000000000000", "2026-09-10T08:00:00Z"),
      session("aaaaaaaa-0000-4000-8000-000000000000", "2026-09-10T08:00:00Z"),
      session("cccccccc-0000-4000-8000-000000000000", "not a date"),
    ];
    expect(orderSessions(tied).map((row) => row.id[0])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(orderSessions(tied)).not.toBe(tied);
    expect(tied[0]!.id.startsWith("b")).toBe(true);
  });
});
