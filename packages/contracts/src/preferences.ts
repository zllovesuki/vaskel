import { z } from "zod";

export const UiLanguageSchema = z.enum(["en", "zh-Hans", "zh-Hant", "ja"]);
export type UiLanguage = z.infer<typeof UiLanguageSchema>;

export const AccountPreferencesSchema = z
  .strictObject({
    language: UiLanguageSchema.nullable(),
    revision: z.number().int().nonnegative(),
  })
  .refine(
    ({ language, revision }) =>
      language === null ? revision === 0 : revision > 0,
    { message: "Only an unsaved language preference has revision zero." },
  );
export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;

export const UpdateAccountPreferencesRequestSchema = z.strictObject({
  language: UiLanguageSchema,
});
export const UpdateAccountPreferencesResponseSchema = z.union([
  z.strictObject({
    kind: z.literal("preferences_updated"),
    preferences: AccountPreferencesSchema,
  }),
  z.strictObject({
    kind: z.enum(["invalid_input", "unauthenticated", "forbidden", "capacity"]),
  }),
]);
export type UpdateAccountPreferencesResponse = z.infer<
  typeof UpdateAccountPreferencesResponseSchema
>;
