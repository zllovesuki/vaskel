import { expect, it } from "vitest";
import { MessageBodySchema } from "@vaskel/contracts/messaging";

it("accepts bounded graphemes and bytes without conflating supplementary characters with UTF-16 length", () => {
  expect(MessageBodySchema.safeParse("𠮷".repeat(4_000)).success).toBe(true);
  expect(MessageBodySchema.safeParse("a\u0301".repeat(4_000)).success).toBe(
    true,
  );
  expect(MessageBodySchema.safeParse("a".repeat(4_001)).success).toBe(false);
  expect(
    MessageBodySchema.safeParse("a" + "\u0301".repeat(20_000)).success,
  ).toBe(false);
});
