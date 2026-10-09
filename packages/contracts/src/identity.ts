import { z } from "zod";
import { AccountPreferencesSchema } from "./preferences";

/** Refusal-only correlation with the caller's account; never authentication. */
export const EXPECTED_ACCOUNT_HEADER = "X-Vaskel-Expected-Account";

export const EmailSchema = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const PasswordSchema = z.string().min(12).max(256);
const displayNameGraphemes = new Intl.Segmenter("und", {
  granularity: "grapheme",
});
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => Array.from(displayNameGraphemes.segment(value)).length <= 100,
    "Display name must contain at most 100 graphemes.",
  );
export const IdentityTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const RegisterAccountRequestSchema = z.strictObject({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});
export const BootstrapRequestSchema = RegisterAccountRequestSchema.extend({
  bootstrapSecret: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const SignInRequestSchema = z.strictObject({
  email: EmailSchema,
  password: z.string().min(1).max(256),
});
export const RequestPasswordResetSchema = z.strictObject({
  email: EmailSchema,
});
export const ResetPasswordRequestSchema = z.strictObject({
  token: IdentityTokenSchema,
  password: PasswordSchema,
});
export const VerifyEmailRequestSchema = z.strictObject({
  token: IdentityTokenSchema,
});
export const OperatorPasswordResetRequestSchema = z.strictObject({
  userId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export const IdentityFailureSchema = z.strictObject({
  status: z.enum([
    "invalid_request",
    "forbidden",
    "unauthenticated",
    "unavailable",
    "rate_limited",
    "instance_capacity",
    "invalid_credentials",
    "email_unverified",
    "invalid_token",
    "bootstrap_complete",
    "bootstrap_expired",
    "email_taken",
    "authorization_conflict",
  ]),
});
export const IdentityProfileSchema = z.strictObject({
  userId: z.uuid(),
  displayName: DisplayNameSchema,
  email: EmailSchema,
  isOperator: z.boolean(),
  expiresAt: z.iso.datetime(),
  preferences: AccountPreferencesSchema,
});
export const IdentityMeResponseSchema = z.union([
  z.strictObject({
    status: z.literal("authenticated"),
    user: IdentityProfileSchema,
  }),
  IdentityFailureSchema,
]);
export const BootstrapStatusResponseSchema = z.union([
  z.strictObject({ status: z.enum(["available", "complete", "unavailable"]) }),
  IdentityFailureSchema,
]);
export const RegisterAccountResponseSchema = z.union([
  z.strictObject({
    status: z.literal("registered"),
    userId: z.uuid(),
    mailDelivery: z.enum(["sent", "pending"]),
  }),
  IdentityFailureSchema,
]);
export const SignInResponseSchema = IdentityMeResponseSchema;
export const SignOutResponseSchema = z.union([
  z.strictObject({ status: z.literal("signed_out") }),
  IdentityFailureSchema,
]);
export const RequestPasswordResetResponseSchema = z.union([
  z.strictObject({ status: z.literal("accepted") }),
  IdentityFailureSchema,
]);
export const ResetPasswordResponseSchema = z.union([
  z.strictObject({ status: z.literal("password_reset") }),
  IdentityFailureSchema,
]);
export const VerifyEmailResponseSchema = z.union([
  z.strictObject({ status: z.literal("email_verified") }),
  IdentityFailureSchema,
]);

export type RegisterAccountRequest = z.infer<
  typeof RegisterAccountRequestSchema
>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type IdentityFailure = z.infer<typeof IdentityFailureSchema>;
export type IdentityProfile = z.infer<typeof IdentityProfileSchema>;
export type IdentityMeResponse = z.infer<typeof IdentityMeResponseSchema>;
export type RegisterAccountResponse = z.infer<
  typeof RegisterAccountResponseSchema
>;
