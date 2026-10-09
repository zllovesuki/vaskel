import { Hash, Volume2 } from "lucide-react";
import { useId, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ResourceSummary } from "@vaskel/contracts/directory";
import { api } from "@/client/api/contract";
import { directoryKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { resourceLocation } from "@/client/routes/resource-location";
import { Form } from "@/client/ui/forms/controls";
import { useAppForm } from "@/client/ui/forms/use-app-form";
import { Failure } from "@/client/ui/failure";
import {
  buttonRowStyles,
  buttonStyles,
  formStyles,
} from "@vaskel/ui/components/control-styles";

export function NewChannelForm({
  resource,
  close,
}: {
  resource: ResourceSummary;
  close: () => void;
}) {
  const { t } = useI18n();
  const { canUseNetwork } = useAccess();
  const [channelId] = useState(() => crypto.randomUUID());
  const kindName = useId();
  const user = useUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: async ({
      name,
      kind,
      isPrivate,
    }: {
      name: string;
      kind: "text" | "media";
      isPrivate: boolean;
    }) => {
      const result = await api.createChannel({
        params: { id: resource.owner.id },
        body: {
          channelId,
          name: name.trim(),
          kind,
          private: isPrivate,
          expectedVersion: resource.version,
        },
      });
      if (result.kind !== "changed")
        throw new UiMessageError(message("workspace.channelCreateFailed"));
      await client.invalidateQueries({
        queryKey: directoryKey(user.userId),
      });
      await navigate({
        ...resourceLocation(resource.owner, channelId),
        search: {},
      });
      close();
    },
  });
  const form = useAppForm({
    defaultValues: {
      name: "",
      kind: "text" as "text" | "media",
      isPrivate: false,
    },
    onSubmit: ({ value }) => {
      create.mutate(value);
    },
  });
  const name = useStore(form.store, (state) => state.values.name);
  const busy = !canUseNetwork || create.isPending;
  const kinds = [
    {
      value: "text" as const,
      icon: Hash,
      title: t("workspace.textRoom"),
      hint: t("workspace.textRoomHint"),
    },
    {
      value: "media" as const,
      icon: Volume2,
      title: t("workspace.voiceRoom"),
      hint: t("workspace.voiceRoomHint"),
    },
  ];
  return (
    <Form className={formStyles} form={form}>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-ui font-medium">
          {t("workspace.roomKind")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {kinds.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3 transition-colors duration-150 ease-out hover:bg-wash has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            >
              <form.Field name="kind">
                {(field) => (
                  <input
                    type="radio"
                    name={kindName}
                    className="sr-only"
                    value={option.value}
                    checked={field.state.value === option.value}
                    disabled={busy}
                    onChange={() => field.handleChange(option.value)}
                  />
                )}
              </form.Field>
              <option.icon
                className="mt-0.5 size-4 shrink-0 text-muted"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-ui font-medium">
                  {option.title}
                </span>
                <span className="block text-caption text-muted">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <form.AppField name="name">
        {(field) => (
          <field.TextField
            label={t("workspace.channelName")}
            maxLength={100}
            required
            data-autofocus
            disabled={busy}
            placeholder={t("workspace.channelPlaceholder")}
          />
        )}
      </form.AppField>
      <form.AppField name="isPrivate">
        {(field) => (
          <field.Checkbox
            label={t("workspace.privateChannel")}
            hint={t("workspace.privateRoomHint")}
            disabled={busy}
          />
        )}
      </form.AppField>
      <Failure error={create.error} />
      <div className={`${buttonRowStyles} justify-end`}>
        <button
          type="button"
          className={buttonStyles({ variant: "quiet" })}
          disabled={create.isPending}
          onClick={close}
        >
          {t("chat.cancel")}
        </button>
        <button
          className={buttonStyles({ variant: "primary" })}
          disabled={busy || !name.trim()}
        >
          {create.isPending ? t("workspace.adding") : t("workspace.addChannel")}
        </button>
      </div>
    </Form>
  );
}
