import { Link } from "@tanstack/react-router";
import { Form } from "@/client/ui/forms/controls";
import {
  AuthFrame,
  EntryError,
  EntryExit,
  EntryNotice,
  EntrySubmit,
} from "./frame";
import { EmailField, PasswordField } from "./fields";
import { api } from "@/client/api/contract";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formStyles } from "@vaskel/ui/components/control-styles";

import { useI18n } from "@/client/features/i18n/use-i18n";
import { useAppForm } from "@/client/ui/forms/use-app-form";

import { useAccess } from "@/client/features/cache/access/context";
import { useOptionalUser } from "./session-state";

export function RequestPasswordResetPage() {
  const { t } = useI18n();
  const user = useOptionalUser();
  const action = useMutation({
    mutationFn: async ({ email }: { email: string }) => {
      await api.requestPasswordReset({ body: { email } });
    },
  });
  const form = useAppForm({
    defaultValues: { email: "" },
    onSubmit: ({ value }) => action.mutate(value),
  });
  return (
    <AuthFrame
      title={t("auth.resetPassword")}
      description={t("auth.forgotDescription")}
    >
      <Form form={form} className={formStyles}>
        <form.AppField name="email">{() => <EmailField />}</form.AppField>
        <EntryError error={action.error} />
        {action.isSuccess && <EntryNotice>{t("auth.resetSent")}</EntryNotice>}
        <EntrySubmit pending={action.isPending}>
          {t("auth.sendReset")}
        </EntrySubmit>
      </Form>
      {!user && (
        <div className="mt-4 flex items-center justify-between gap-4 text-caption">
          <Link to="/sign-in" search={{}}>
            {t("auth.backToSignIn")}
          </Link>
        </div>
      )}
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const { t } = useI18n();
  const user = useOptionalUser();
  const access = useAccess();
  const navigate = useNavigate();
  const { token = "" } = useSearch({ strict: false });
  const action = useMutation({
    mutationFn: async ({ password }: { password: string }) => {
      await api.resetPassword({ body: { token, password } });

      form.setFieldValue("password", "");
      if (user) {
        await access.retry();
        await navigate({ to: "/sign-in", search: {} });
      }
    },
  });
  const form = useAppForm({
    defaultValues: { password: "" },
    onSubmit: ({ value }) => action.mutate(value),
  });
  if (action.isSuccess)
    return (
      <AuthFrame
        title={t("auth.passwordChangedTitle")}
        description={t("auth.passwordChangedDescription")}
        focusKey="password-changed"
      >
        <EntryExit done />
      </AuthFrame>
    );
  return (
    <AuthFrame
      title={t("auth.newPassword")}
      description={t("auth.resetDescription")}
    >
      <Form form={form} className={formStyles}>
        <form.AppField name="password">
          {() => <PasswordField purpose="new" />}
        </form.AppField>
        <EntryError error={action.error} />
        <EntrySubmit pending={action.isPending} disabled={!token}>
          {t("auth.savePassword")}
        </EntrySubmit>
      </Form>
      {!user && (
        <div className="mt-4 flex items-center justify-between gap-4 text-caption">
          <Link to="/sign-in" search={{}}>
            {t("auth.backToSignIn")}
          </Link>
        </div>
      )}
    </AuthFrame>
  );
}
