import { Link, Navigate } from "@tanstack/react-router";
import { Form } from "@/client/ui/forms/controls";
import { AuthFrame, EntryError, EntryNotice, EntrySubmit } from "./frame";
import { EmailField, PasswordField } from "./fields";
import { apiFailure } from "@/client/api/errors";
import { useMutation } from "@tanstack/react-query";

import {
  formStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";

import { useAppForm } from "@/client/ui/forms/use-app-form";

import { useI18n } from "@/client/features/i18n/use-i18n";
import { useOptionalUser } from "./session-state";
import { pendingInvitation } from "./pending-invitation";

import {
  useBootstrapStatus,
  useSignInRequest,
  useVerificationResend,
} from "./credentials";

export function SignInPage() {
  const user = useOptionalUser();
  if (!user) return <SignInForm />;
  const token = pendingInvitation(user.email);
  return token ? (
    <Navigate to="/invite" search={{ token }} replace />
  ) : (
    <Navigate to="/" search={{}} replace />
  );
}

/** Also mounts at protected URLs, so account admission resumes the same destination. */
export function SignInForm({
  returnToResource = false,
}: {
  returnToResource?: boolean;
}) {
  const { t } = useI18n();
  const setup = useBootstrapStatus(true);
  const signIn = useSignInRequest();
  const action = useMutation({ mutationFn: signIn });
  const resend = useVerificationResend();
  const form = useAppForm({
    defaultValues: { email: "", password: "" },
    onSubmit: ({ value }) => {
      resend.reset();
      action.mutate(value);
    },
  });
  const unverified =
    apiFailure(action.error) &&
    apiFailure(action.error)?.code === "email_unverified";
  return (
    <AuthFrame title={t("auth.signIn")}>
      <Form form={form} className={formStyles}>
        <form.AppField name="email">{() => <EmailField />}</form.AppField>
        <form.AppField name="password">
          {() => <PasswordField purpose="current" />}
        </form.AppField>
        <EntryError error={action.error} />
        <EntryError error={resend.error} />
        {resend.isSuccess && (
          <EntryNotice>{t("auth.verificationSent")}</EntryNotice>
        )}
        <EntrySubmit pending={action.isPending}>{t("auth.signIn")}</EntrySubmit>
      </Form>
      <div className="mt-4 flex items-center justify-between gap-4 text-caption">
        {unverified ? (
          <button
            className={textButtonStyles()}
            disabled={resend.isPending}
            onClick={() => resend.mutate(form.getFieldValue("email"))}
          >
            {t("auth.resendVerification")}
          </button>
        ) : (
          returnToResource && (
            <Link to="/sign-in" search={{}}>
              {t("auth.backToSignIn")}
            </Link>
          )
        )}
        <Link to="/forgot-password" search={{}}>
          {t("auth.forgotPassword")}
        </Link>
      </div>
      <p className="mt-8 text-caption text-muted">
        {t("auth.invitationRequired")}
        {setup.data?.status === "available" && (
          <>
            {" "}
            <Link to="/bootstrap" search={{}}>
              {t("auth.setupInstance")}
            </Link>
          </>
        )}
      </p>
    </AuthFrame>
  );
}
