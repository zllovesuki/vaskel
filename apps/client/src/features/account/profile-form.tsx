import { useAppForm } from "@/client/ui/forms/use-app-form";
import { Form } from "@/client/ui/forms/controls";
import { z } from "zod";
import { useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { updateProfile } from "@/client/api/account";
import { errorMessage, privateKey } from "@/client/api/client";
import { DisplayNameSchema } from "@vaskel/contracts/identity";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  formStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";

/** The name every circle, conversation and message shows for this account. */
export function ProfileForm() {
  const { t, text } = useI18n();
  const user = useUser();
  const { canUseNetwork, checkSession } = useAccess();
  const save = useMutation({
    mutationKey: [...privateKey(user.userId), "profile"],
    networkMode: "always",
    retry: false,
    mutationFn: async (next: string) => {
      const result = await updateProfile(next);
      // Identity owns the signed-in profile; read it back rather than patch it.
      await checkSession();
      return result.displayName;
    },
  });
  const form = useAppForm({
    defaultValues: { name: user.displayName },
    onSubmit: ({ value }) => {
      save.mutate(DisplayNameSchema.parse(value.name));
    },
    validators: { onChange: z.object({ name: DisplayNameSchema }) },
  });
  const name = useStore(form.store, (state) => state.values.name);
  const parsed = DisplayNameSchema.safeParse(name);
  // The response carries the stored name, so the form settles on the
  // authoritative answer even while a session read still reports the old one.
  const saved = save.isSuccess ? save.data : null;
  const changed = parsed.success && parsed.data !== (saved ?? user.displayName);
  return (
    <Form className={formStyles} form={form}>
      <form.AppField
        name="name"
        listeners={{
          onChange: () => {
            if (save.isSuccess) save.reset();
          },
        }}
      >
        {(field) => (
          <field.TextField
            label={t("auth.displayName")}
            autoComplete="nickname"
            required
            maxLength={100}
          />
        )}
      </form.AppField>
      {save.error && (
        <p role="alert" className={noticeStyles({ error: true })}>
          {text(errorMessage(save.error))}
        </p>
      )}
      {save.isSuccess && !changed && (
        <p role="status" className={noticeStyles()}>
          {t("account.profileSaved")}
        </p>
      )}
      <div>
        <button
          className={buttonStyles({ variant: "primary" })}
          disabled={!canUseNetwork || save.isPending || !changed}
        >
          {save.isPending ? t("account.saving") : t("account.saveName")}
        </button>
      </div>
    </Form>
  );
}
