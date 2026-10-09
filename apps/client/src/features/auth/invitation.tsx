import { Link } from "@tanstack/react-router";
import { Form } from "@/client/ui/forms/controls";
import {
  AuthFrame,
  EntryError,
  EntryExit,
  EntryNotice,
  EntrySubmit,
} from "./frame";
import { DisplayNameField, EmailField, PasswordField } from "./fields";
import { apiFailure } from "@/client/api/errors";
import { api } from "@/client/api/contract";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  formStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";

import { errorMessage, PRIVATE_ROOT } from "@/client/api/client";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useAppForm } from "@/client/ui/forms/use-app-form";

import { useOptionalUser } from "./session-state";
import { forgetInvitation, rememberInvitation } from "./pending-invitation";

import { useSignInRequest, useVerificationResend } from "./credentials";

type Invitation = { name: string; expiresAt: number };

export function InvitationPage() {
  const user = useOptionalUser();
  const { t, text } = useI18n();
  const { token = "" } = useSearch({ strict: false });
  const invitation = useQuery({
    queryKey: ["invitation", token, user?.userId ?? null],
    queryFn: async ({ signal }) => {
      try {
        return await api.inspectInvite({ body: { token } }, { signal: signal });
      } catch (error) {
        if (
          user &&
          apiFailure(error) &&
          apiFailure(error)?.code === "not_found"
        )
          forgetInvitation(token);
        throw error;
      }
    },
    enabled: token.length > 0,
    retry: false,
  });
  if (!token)
    return (
      <AuthFrame
        title={t("auth.inviteIncomplete")}
        description={t("auth.inviteIncompleteDescription")}
      >
        <EntryExit />
      </AuthFrame>
    );
  if (invitation.error)
    return (
      <AuthFrame
        title={t("auth.inviteUnusable")}
        description={`${text(errorMessage(invitation.error))} ${t("auth.inviteRecovery")}`}
        descriptionRole="alert"
      >
        <EntryExit />
      </AuthFrame>
    );
  return user ? (
    <JoinInvitation token={token} invitation={invitation.data} />
  ) : (
    <InvitationCredentials token={token} invitation={invitation.data} />
  );
}

function JoinInvitation({
  token,
  invitation,
}: {
  token: string;
  invitation: Invitation | undefined;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const navigate = useNavigate();
  const join = useMutation({
    mutationFn: async () => {
      const joined = await api.joinInvite({
        body: {
          token,
        },
      });
      forgetInvitation(token);
      void client.invalidateQueries({ queryKey: PRIVATE_ROOT });
      await navigate({
        to: "/servers/$serverId",
        params: { serverId: joined.serverId },
        search: {},
      });
    },
  });
  const form = useAppForm({ defaultValues: {}, onSubmit: () => join.mutate() });
  return (
    <AuthFrame
      title={t("auth.joinServer")}
      description={
        invitation
          ? t("auth.invited", { name: invitation.name })
          : t("auth.checkingInvitation")
      }
    >
      <Form form={form} className={formStyles}>
        <EntryError error={join.error} />
        <EntrySubmit pending={join.isPending} disabled={!invitation}>
          {invitation
            ? t("auth.joinNamedServer", { name: invitation.name })
            : t("auth.joinServer")}
        </EntrySubmit>
      </Form>
    </AuthFrame>
  );
}

type CredentialsStage =
  | { kind: "register" }
  | { kind: "sign-in" }
  | { kind: "registered"; email: string };

/** One invitation keeps credentials and registration identity while the person changes steps. */
function InvitationCredentials({
  token,
  invitation,
}: {
  token: string;
  invitation: Invitation | undefined;
}) {
  const { t } = useI18n();
  const [registrationId] = useState(() => crypto.randomUUID());
  const [stage, setStage] = useState<CredentialsStage>({ kind: "register" });
  const signInRequest = useSignInRequest();
  const signIn = useMutation({ mutationFn: signInRequest });
  const resend = useVerificationResend();
  const registration = useMutation({
    mutationFn: async ({
      email,
      password,
      displayName,
    }: {
      email: string;
      password: string;
      displayName: string;
    }) => {
      await api.registerInvite({
        body: { token, registrationId, email, password, displayName },
      });

      const address = email.trim().toLowerCase();
      if (invitation)
        rememberInvitation({
          token,
          email: address,
          expiresAt: invitation.expiresAt,
        });
      form.setFieldValue("password", "");
      setStage({ kind: "registered", email: address });
    },
  });
  const form = useAppForm({
    defaultValues: { email: "", password: "", displayName: "" },
    onSubmit: ({ value }) => {
      resend.reset();
      if (stage.kind === "register") registration.mutate(value);
      else signIn.mutate(value);
    },
  });
  const registering = stage.kind === "register";
  const action = registering ? registration : signIn;
  const resendable =
    stage.kind === "registered" ||
    (apiFailure(action.error) &&
      apiFailure(action.error)?.code === "email_unverified");
  let title = t("auth.createAccount");
  if (stage.kind === "sign-in") title = t("auth.signInToJoin");
  if (stage.kind === "registered") title = t("auth.checkEmail");
  const description =
    stage.kind === "registered" && invitation
      ? t("auth.checkEmailToJoin", {
          email: stage.email,
          name: invitation.name,
        })
      : invitation
        ? t("auth.invited", { name: invitation.name })
        : t("auth.checkingInvitation");
  return (
    <AuthFrame
      title={title}
      description={description}
      focusKey={stage.kind === "registered" ? "registered" : null}
    >
      <Form form={form} className={formStyles}>
        {registering && (
          <form.AppField name="displayName">
            {() => <DisplayNameField />}
          </form.AppField>
        )}
        <form.AppField name="email">{() => <EmailField />}</form.AppField>
        <form.AppField name="password">
          {() => <PasswordField purpose={registering ? "new" : "current"} />}
        </form.AppField>
        <EntryError error={action.error} />
        <EntryError error={resend.error} />
        {resend.isSuccess && (
          <EntryNotice>{t("auth.verificationSent")}</EntryNotice>
        )}
        <EntrySubmit pending={action.isPending} disabled={!invitation}>
          {registering ? t("auth.createAccount") : t("auth.signIn")}
        </EntrySubmit>
      </Form>
      <div className="mt-4 flex items-center justify-between gap-4 text-caption">
        {resendable ? (
          <button
            className={textButtonStyles()}
            disabled={resend.isPending}
            onClick={() => resend.mutate(form.getFieldValue("email"))}
          >
            {t("auth.resendVerification")}
          </button>
        ) : (
          <button
            className={textButtonStyles()}
            onClick={() => {
              setStage({ kind: registering ? "sign-in" : "register" });
              registration.reset();
              signIn.reset();
            }}
          >
            {registering ? t("auth.alreadyAccount") : t("auth.createAnAccount")}
          </button>
        )}
        {stage.kind === "sign-in" && (
          <Link to="/forgot-password" search={{}}>
            {t("auth.forgotPassword")}
          </Link>
        )}
      </div>
    </AuthFrame>
  );
}
