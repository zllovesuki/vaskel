import { Link } from "@tanstack/react-router";
import { Form } from "@/client/ui/forms/controls";
import { AuthFrame, EntryError, EntryNotice, EntrySubmit } from "./frame";
import {
  DisplayNameField,
  EmailField,
  PasswordField,
  SetupKeyField,
} from "./fields";
import { type Credentials } from "./credentials";
import { api } from "@/client/api/contract";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  formStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";

import { useI18n } from "@/client/features/i18n/use-i18n";
import { useAppForm } from "@/client/ui/forms/use-app-form";

import { useOptionalUser } from "./session-state";

import {
  useBootstrapStatus,
  useSignInRequest,
  useVerificationResend,
} from "./credentials";

export function BootstrapPage() {
  const { t } = useI18n();
  const user = useOptionalUser();
  const setup = useBootstrapStatus(!user);
  const navigate = useNavigate();
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const signInRequest = useSignInRequest();
  const signIn = useMutation({
    mutationFn: async (credentials: Credentials) => {
      await signInRequest(credentials);
      await navigate({ to: "/", search: {} });
    },
  });
  const resend = useVerificationResend();
  const registration = useMutation({
    mutationFn: async ({
      email,
      password,
      displayName,
      secret,
    }: {
      email: string;
      password: string;
      displayName: string;
      secret: string;
    }) => {
      await api.bootstrap({
        body: { email, password, displayName, bootstrapSecret: secret },
      });

      form.setFieldValue("password", "");
      setRegisteredEmail(email.trim().toLowerCase());
    },
  });
  const form = useAppForm({
    defaultValues: { email: "", password: "", displayName: "", secret: "" },
    onSubmit: ({ value }) => {
      resend.reset();
      if (registeredEmail) signIn.mutate(value);
      else registration.mutate(value);
    },
  });
  const action = registeredEmail ? signIn : registration;
  return (
    <AuthFrame
      title={registeredEmail ? t("auth.checkEmail") : t("auth.setup")}
      description={
        registeredEmail
          ? t("auth.checkEmailToSetUp", { email: registeredEmail })
          : t("auth.setupDescription")
      }
      focusKey={registeredEmail ? "registered" : null}
    >
      <Form form={form} className={formStyles}>
        {!registeredEmail && (
          <>
            {setup.data && setup.data.status !== "available" && (
              <EntryNotice>
                {setup.data.status === "complete"
                  ? t("auth.setupComplete")
                  : t("auth.setupUnavailable")}
              </EntryNotice>
            )}
            <EntryError error={setup.error} />
            <form.AppField name="displayName">
              {() => <DisplayNameField />}
            </form.AppField>
          </>
        )}
        <form.AppField name="email">{() => <EmailField />}</form.AppField>
        <form.AppField name="password">
          {() => (
            <PasswordField purpose={registeredEmail ? "current" : "new"} />
          )}
        </form.AppField>
        {!registeredEmail && (
          <form.AppField name="secret">{() => <SetupKeyField />}</form.AppField>
        )}
        <EntryError error={action.error} />
        <EntryError error={resend.error} />
        {resend.isSuccess && (
          <EntryNotice>{t("auth.verificationSent")}</EntryNotice>
        )}
        <EntrySubmit
          pending={action.isPending}
          disabled={!registeredEmail && setup.data?.status !== "available"}
        >
          {registeredEmail ? t("auth.signIn") : t("auth.createAccount")}
        </EntrySubmit>
      </Form>
      <div className="mt-4 flex items-center justify-between gap-4 text-caption">
        {registeredEmail ? (
          <button
            className={textButtonStyles()}
            disabled={resend.isPending}
            onClick={() => resend.mutate(form.getFieldValue("email"))}
          >
            {t("auth.resendVerification")}
          </button>
        ) : (
          !user && (
            <Link to="/sign-in" search={{}}>
              {t("auth.backToSignIn")}
            </Link>
          )
        )}
      </div>
    </AuthFrame>
  );
}
