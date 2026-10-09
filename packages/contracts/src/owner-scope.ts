import * as z from "zod/mini";

/** Shared by message APIs and the small service-worker notification payload. */
export const OwnerScopeSchema = z.strictObject({
  kind: z.enum(["server", "conversation"]),
  id: z.string().check(z.minLength(1), z.maxLength(128)),
});
export type OwnerScope = z.infer<typeof OwnerScopeSchema>;
