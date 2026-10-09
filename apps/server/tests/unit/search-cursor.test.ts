import { describe, expect, it } from "vitest";
import {
  CROSS_SEARCH_CURSOR_MAX_LENGTH,
  type SearchPosition,
} from "@vaskel/contracts/search";
import { decodeSearchCursor, encodeSearchCursor } from "@/server/search/cursor";
const position: SearchPosition = {
  serverId: "00000000-0000-4000-8000-000000000001",
  messageId: "日".repeat(128),
  createdAt: Number.MAX_SAFE_INTEGER,
  createdSequence: Number.MAX_SAFE_INTEGER,
};
describe("creation-position search cursor", () => {
  it("round trips bounded creation positions without account, query or cohort state", () => {
    const token = encodeSearchCursor(position);
    expect(token.length).toBeLessThanOrEqual(CROSS_SEARCH_CURSOR_MAX_LENGTH);
    expect(decodeSearchCursor(token)).toEqual(position);
    expect(
      decodeSearchCursor(encodeSearchCursor({ ...position, createdAt: 0 })),
    ).toEqual({ ...position, createdAt: 0 });
  });
  it("rejects malformed encodings, invalid positions and obsolete authority fields", () => {
    for (const value of [
      { ...position, createdAt: -1 },
      { ...position, createdSequence: 0 },
      { ...position, serverId: "invalid" },
      { ...position, owners: [] },
      { ...position, expiresAt: 1 },
      { ...position, accountId: "account" },
    ])
      expect(
        decodeSearchCursor(
          Buffer.from(JSON.stringify(value)).toString("base64url"),
        ),
      ).toBeNull();
    for (const token of [
      "",
      "broken.cursor!",
      "_",
      "x".repeat(CROSS_SEARCH_CURSOR_MAX_LENGTH + 1),
      "e30",
    ])
      expect(decodeSearchCursor(token)).toBeNull();
  });
});
