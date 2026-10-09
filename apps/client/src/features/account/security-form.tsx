import { Form } from "@/client/ui/forms/controls";
import { apiFailure } from "@/client/api/errors";
import { useAppForm } from "@/client/ui/forms/use-app-form";

import { useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { changePassword, sessionsKey } from "@/client/api/account";
import { errorMessage, privateKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  formStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";

/** Changing the password keeps this device signed in, whatever it revokes. */
export function SecurityForm() {
  const { t, text } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const client = useQueryClient();
  const change = useMutation({
    mutationKey: [...privateKey(user.userId), "change-password"],
    networkMode: "always",
    retry: false,
    mutationFn: async ({
      current,
      next,
      others,
    }: {
      current: string;
      next: string;
      others: boolean;
    }) => {
      const revoked = others;
      await changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revoked,
      });
      form.reset({ current: "", next: "", confirm: "", others: revoked });
      // Revoking other devices changes the list the sessions section shows.
      if (revoked)
        await client.invalidateQueries({ queryKey: sessionsKey(user.userId) });
      return revoked;
    },
  });
  const wrongPassword =
    apiFailure(change.error) &&
    apiFailure(change.error)?.code === "invalid_credentials";
  const form = useAppForm({
    defaultValues: { current: "", next: "", confirm: "", others: false },
    validators: {
      onSubmit: ({ value }) =>
        value.next !== value.confirm ? "mismatch" : undefined,
    },
    onSubmit: ({ value }) => {
      change.mutate(value);
    },
  });
  const mismatch = useStore(
    form.store,
    (state) => state.errorMap.onSubmit === "mismatch",
  );
  return (
    <Form className={formStyles} form={form}>
      <form.AppField name="current">
        {(field) => (
          <field.TextField
            label={t("account.currentPassword")}
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
        )}
      </form.AppField>
      <form.AppField name="next">
        {(field) => (
          <field.TextField
            label={t("account.newPassword")}
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
            hint={t("auth.passwordHint")}
          />
        )}
      </form.AppField>
      <form.AppField name="confirm">
        {(field) => (
          <field.TextField
            label={t("account.confirmPassword")}
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
          />
        )}
      </form.AppField>
      <form.AppField name="others">
        {(field) => (
          <field.Checkbox
            label={t("account.signOutOthers")}
            hint={t("account.signOutOthersHint")}
            disabled={change.isPending}
          />
        )}
      </form.AppField>
      {mismatch && (
        <p role="alert" className={noticeStyles({ error: true })}>
          {t("account.passwordMismatch")}
        </p>
      )}
      {change.error && (
        <p role="alert" className={noticeStyles({ error: true })}>
          {wrongPassword
            ? t("account.passwordWrong")
            : text(errorMessage(change.error))}
        </p>
      )}
      {change.isSuccess && (
        <p role="status" className={noticeStyles()}>
          {change.data
            ? t("account.passwordSavedElsewhere")
            : t("account.passwordSaved")}
        </p>
      )}
      <div>
        <button
          className={buttonStyles({ variant: "primary" })}
          disabled={!canUseNetwork || change.isPending}
        >
          {change.isPending ? t("account.saving") : t("account.changePassword")}
        </button>
      </div>
    </Form>
  );
}
