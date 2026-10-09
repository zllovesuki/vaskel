import { useAppForm } from "@/client/ui/forms/use-app-form";
import { Form } from "@/client/ui/forms/controls";
import { useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonRowStyles,
  buttonStyles,
  fieldHintStyles,
  formStyles,
} from "@vaskel/ui/components/control-styles";
import type { CircleResource } from "./types";
import { useCommands } from "./commands";
import { Failure } from "@/client/ui/failure";

/** The circle's name and who may bring people in. */
export function Overview({ resource }: { resource: CircleResource }) {
  const { t } = useI18n();
  const { canUseNetwork } = useAccess();
  const { run, busy } = useCommands();
  const rename = useMutation({
    mutationFn: (name: string) =>
      run({
        action: "rename",
        body: { name: name.trim(), expectedVersion: resource.version },
      }),
  });
  const policy = useMutation({
    mutationFn: (membersMayInvite: boolean) =>
      run({
        action: "settings",
        body: { membersMayInvite, expectedVersion: resource.version },
      }),
  });
  const form = useAppForm({
    defaultValues: { name: resource.name },
    onSubmit: ({ value }) => {
      rename.mutate(value.name);
    },
  });
  const name = useStore(form.store, (state) => state.values.name);
  const blocked = !canUseNetwork || busy;
  return (
    <>
      <Form className={formStyles} form={form}>
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label={t("workspace.serverName")}
              maxLength={100}
              required
              disabled={rename.isPending}
            />
          )}
        </form.AppField>
        <div className={buttonRowStyles}>
          <button
            className={buttonStyles({ variant: "primary", size: "small" })}
            disabled={blocked || !name.trim() || name.trim() === resource.name}
          >
            {rename.isPending ? t("workspace.saving") : t("workspace.save")}
          </button>
        </div>
        <Failure error={rename.error} />
      </Form>
      <label className="flex cursor-pointer items-start gap-2.5 text-ui">
        <input
          type="checkbox"
          role="switch"
          className="mt-1 size-4 shrink-0 accent-accent"
          checked={resource.membersMayInvite ?? false}
          disabled={blocked}
          onChange={(event) => policy.mutate(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block font-medium">
            {t("workspace.membersMayInvite")}
          </span>
          <span className={fieldHintStyles}>
            {t("workspace.membersMayInviteHint")}
          </span>
        </span>
      </label>
      <Failure error={policy.error} />
    </>
  );
}
