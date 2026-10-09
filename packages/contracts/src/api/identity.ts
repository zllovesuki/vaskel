import { identityErrors } from "./errors";
import { z } from "zod";
import { operation, empty, sessionSecurity } from "./base";
import { identityResult } from "./outcome";
import {
  BootstrapRequestSchema,
  BootstrapStatusResponseSchema,
  IdentityMeResponseSchema,
  OperatorPasswordResetRequestSchema,
  RegisterAccountResponseSchema,
  RequestPasswordResetResponseSchema,
  RequestPasswordResetSchema,
  ResetPasswordRequestSchema,
  ResetPasswordResponseSchema,
  SignInRequestSchema,
  SignInResponseSchema,
  SignOutResponseSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
} from "../identity";
import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  ListSessionsResponseSchema,
  RevokeSessionRequestSchema,
  RevokeSessionResponseSchema,
  UpdateProfileRequestSchema,
  UpdateProfileResponseSchema,
} from "../account";
const identity = operation.errors(identityErrors);
export const identityApiContract = {
  me: identity
    .meta({ authority: "identity" })
    .route({
      spec: (spec) => ({ ...spec, security: sessionSecurity }),
      method: "GET",
      path: "/identity/me",
      inputStructure: "detailed",
    })
    .input(empty)
    .output(identityResult(IdentityMeResponseSchema, "authenticated")),
  bootstrapStatus: identity
    .meta({ authority: "public" })
    .route({
      method: "GET",
      path: "/identity/bootstrap",
      inputStructure: "detailed",
    })
    .input(empty)
    .output(
      identityResult(
        BootstrapStatusResponseSchema,
        "available",
        "complete",
        "unavailable",
      ),
    ),
  bootstrap: identity
    .meta({ authority: "public" })
    .route({
      method: "POST",
      path: "/identity/bootstrap",
      successStatus: 201,
      inputStructure: "detailed",
    })
    .input(z.object({ body: BootstrapRequestSchema }))
    .output(identityResult(RegisterAccountResponseSchema, "registered")),
  signIn: identity
    .meta({ authority: "public" })
    .route({
      method: "POST",
      path: "/identity/sign-in",
      inputStructure: "detailed",
    })
    .input(z.object({ body: SignInRequestSchema }))
    .output(identityResult(SignInResponseSchema, "authenticated")),
  signOut: identity
    .meta({ authority: "cleanup" })
    .route({
      method: "POST",
      path: "/identity/sign-out",
      inputStructure: "detailed",
    })
    .input(empty)
    .output(identityResult(SignOutResponseSchema, "signed_out")),
  requestPasswordReset: identity
    .meta({ authority: "public" })
    .route({
      method: "POST",
      path: "/identity/request-password-reset",
      successStatus: 202,
      inputStructure: "detailed",
    })
    .input(z.object({ body: RequestPasswordResetSchema }))
    .output(identityResult(RequestPasswordResetResponseSchema, "accepted")),
  resendVerification: identity
    .meta({ authority: "public" })
    .route({
      method: "POST",
      path: "/identity/resend-verification",
      successStatus: 202,
      inputStructure: "detailed",
    })
    .input(z.object({ body: RequestPasswordResetSchema }))
    .output(identityResult(RequestPasswordResetResponseSchema, "accepted")),
  resetPassword: identity
    .meta({ authority: "public" })
    .route({
      method: "POST",
      path: "/identity/reset-password",
      inputStructure: "detailed",
    })
    .input(z.object({ body: ResetPasswordRequestSchema }))
    .output(identityResult(ResetPasswordResponseSchema, "password_reset")),
  verifyEmail: identity
    .meta({ authority: "public" })
    .route({
      method: "POST",
      path: "/identity/verify-email",
      inputStructure: "detailed",
    })
    .input(z.object({ body: VerifyEmailRequestSchema }))
    .output(identityResult(VerifyEmailResponseSchema, "email_verified")),
  operatorPasswordReset: identity
    .meta({ authority: "capability" })
    .route({
      spec: (spec) => ({ ...spec, security: sessionSecurity }),
      method: "POST",
      path: "/identity/operator/request-password-reset",
      successStatus: 202,
      inputStructure: "detailed",
    })
    .input(z.object({ body: OperatorPasswordResetRequestSchema }))
    .output(identityResult(RequestPasswordResetResponseSchema, "accepted")),
  profile: identity
    .meta({ authority: "self-service" })
    .route({
      spec: (spec) => ({ ...spec, security: sessionSecurity }),
      method: "POST",
      path: "/identity/profile",
      inputStructure: "detailed",
    })
    .input(z.object({ body: UpdateProfileRequestSchema }))
    .output(identityResult(UpdateProfileResponseSchema, "profile_updated")),
  changePassword: identity
    .meta({ authority: "self-service" })
    .route({
      spec: (spec) => ({ ...spec, security: sessionSecurity }),
      method: "POST",
      path: "/identity/change-password",
      inputStructure: "detailed",
    })
    .input(z.object({ body: ChangePasswordRequestSchema }))
    .output(identityResult(ChangePasswordResponseSchema, "password_changed")),
  sessions: identity
    .meta({ authority: "self-service" })
    .route({
      spec: (spec) => ({ ...spec, security: sessionSecurity }),
      method: "GET",
      path: "/identity/sessions",
      inputStructure: "detailed",
    })
    .input(empty)
    .output(identityResult(ListSessionsResponseSchema, "sessions")),
  revokeSession: identity
    .meta({ authority: "self-service" })
    .route({
      spec: (spec) => ({ ...spec, security: sessionSecurity }),
      method: "POST",
      path: "/identity/revoke-session",
      inputStructure: "detailed",
    })
    .input(z.object({ body: RevokeSessionRequestSchema }))
    .output(identityResult(RevokeSessionResponseSchema, "session_revoked")),
};
