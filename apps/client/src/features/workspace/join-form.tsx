import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAccess } from "@/client/features/cache/access/context";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Form } from "@/client/ui/forms/controls";
import { useAppForm } from "@/client/ui/forms/use-app-form";
import { Failure } from "@/client/ui/failure";
import { buttonStyles, formStyles } from "@vaskel/ui/components/control-styles";

export function JoinForm({ close }: { close: () => void }) {
  const { t } = useI18n();
  const { canUseNetwork } = useAccess();
  const [error, setError] = useState<UiMessageError | null>(null);
  const navigate = useNavigate();
  const form = useAppForm({
    defaultValues: { invitation: "" },
    onSubmit: ({ value }) => {
      let token = value.invitation.trim();
      try {
        const url = new URL(token);
        token = url.searchParams.get("token") ?? "";
      } catch {
        /* A raw invitation token is also accepted. */
      }
      if (!token || token.length > 200) {
        setError(new UiMessageError(message("workspace.invalidInvitation")));
        return;
      }
      void navigate({ to: "/invite", search: { token } });
      close();
    },
  });
  return (
    <Form className={formStyles} form={form}>
      <form.AppField name="invitation">
        {(field) => (
          <field.TextField
            label={t("workspace.invitationLink")}
            type="text"
            disabled={!canUseNetwork}
            placeholder={t("workspace.invitePlaceholder")}
            data-autofocus
            required
          />
        )}
      </form.AppField>
      <Failure error={error} />
      <button
        className={buttonStyles({ variant: "primary" })}
        disabled={!canUseNetwork}
      >
        {t("workspace.continue")}
      </button>
    </Form>
  );
}
