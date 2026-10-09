import { z } from "zod";
import {
  DisplayNameSchema,
  IdentityFailureSchema,
  PasswordSchema,
} from "./identity";

export const UpdateProfileRequestSchema = z.strictObject({
  name: DisplayNameSchema,
});
export const UpdateProfileResponseSchema = z.union([
  z.strictObject({
    status: z.literal("profile_updated"),
    displayName: DisplayNameSchema,
  }),
  IdentityFailureSchema,
]);
export const ChangePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: PasswordSchema,
  revokeOtherSessions: z.boolean(),
});
export const ChangePasswordResponseSchema = z.union([
  z.strictObject({ status: z.literal("password_changed") }),
  IdentityFailureSchema,
]);
export const AccountSessionSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  userAgentFamily: z.enum([
    "Chrome",
    "Edge",
    "Firefox",
    "Safari",
    "Opera",
    "Other",
  ]),
  current: z.boolean(),
});
export const ListSessionsResponseSchema = z.union([
  z.strictObject({
    status: z.literal("sessions"),
    sessions: z.array(AccountSessionSchema).max(100),
    partial: z.boolean(),
  }),
  IdentityFailureSchema,
]);
export const RevokeSessionRequestSchema = z.strictObject({
  sessionId: z.uuid(),
});
export const RevokeSessionResponseSchema = z.union([
  z.strictObject({
    status: z.literal("session_revoked"),
    current: z.boolean(),
  }),
  IdentityFailureSchema,
]);
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export type AccountSession = z.infer<typeof AccountSessionSchema>;

/** Session listings and default notification device labels share one browser vocabulary. */
export function userAgentFamily(
  value: string | null,
): AccountSession["userAgentFamily"] {
  if (/Edg(?:e|A|iOS)?\//i.test(value ?? "")) return "Edge";
  if (/(?:OPR|Opera)\//i.test(value ?? "")) return "Opera";
  if (/(?:Firefox|FxiOS)\//i.test(value ?? "")) return "Firefox";
  if (/(?:Chrome|CriOS)\//i.test(value ?? "")) return "Chrome";
  if (/Safari\//i.test(value ?? "")) return "Safari";
  return "Other";
}
