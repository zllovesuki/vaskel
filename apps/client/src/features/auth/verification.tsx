import { Form } from "@/client/ui/forms/controls";
import { AuthFrame, EntryError, EntryExit, EntrySubmit } from "./frame";
import { apiFailure } from "@/client/api/errors";
import { api } from "@/client/api/contract";
import { useMutation } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { formStyles } from "@vaskel/ui/components/control-styles";
import { IdentityTokenSchema } from "@vaskel/contracts/identity";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useAppForm } from "@/client/ui/forms/use-app-form";

export function VerificationPage() {
  const { t } = useI18n();
  const { token = "" } = useSearch({ strict: false });
  const action = useMutation({
    mutationFn: async () => {
      await api.verifyEmail({ body: { token } });
    },
  });
  const form = useAppForm({
    defaultValues: {},
    onSubmit: () => action.mutate(),
  });
  if (!IdentityTokenSchema.safeParse(token).success)
    return (
      <AuthFrame
        title={t("auth.verifyIncomplete")}
        description={t("auth.verifyIncompleteDescription")}
      >
        <EntryExit />
      </AuthFrame>
    );
  if (
    apiFailure(action.error) &&
    ["invalid_token", "invalid_request"].includes(
      apiFailure(action.error)?.code ?? "",
    )
  )
    return (
      <AuthFrame
        title={t("auth.verifyUnusable")}
        description={t("auth.verifyUnusableDescription")}
        focusKey="unusable"
      >
        <EntryExit />
      </AuthFrame>
    );
  if (action.isSuccess)
    return (
      <AuthFrame
        title={t("auth.emailVerified")}
        description={t("auth.emailVerifiedDescription")}
        focusKey="verified"
      >
        <EntryExit done />
      </AuthFrame>
    );
  return (
    <AuthFrame
      title={t("auth.verifyTitle")}
      description={t("auth.verifyDescription")}
    >
      <Form form={form} className={formStyles}>
        <EntryError error={action.error} />
        <EntrySubmit pending={action.isPending}>
          {t("auth.verifyEmail")}
        </EntrySubmit>
      </Form>
    </AuthFrame>
  );
}
