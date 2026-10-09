import { expect, it } from "vitest";
import { AccountPreferencesSchema } from "@vaskel/contracts/preferences";

it("rejects preference facts that conflate unsaved and committed revisions", () => {
  expect(
    AccountPreferencesSchema.safeParse({ language: null, revision: 1 }).success,
  ).toBe(false);
  expect(
    AccountPreferencesSchema.safeParse({ language: "ja", revision: 0 }).success,
  ).toBe(false);
  expect(
    AccountPreferencesSchema.parse({ language: null, revision: 0 }),
  ).toEqual({ language: null, revision: 0 });
  expect(
    AccountPreferencesSchema.parse({ language: "ja", revision: 1 }),
  ).toEqual({ language: "ja", revision: 1 });
});
