import { Form } from "@/client/ui/forms/controls";
import { useAppForm } from "@/client/ui/forms/use-app-form";
import { useStore } from "@tanstack/react-form";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/client/api/contract";
import { directoryKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { resourceLocation } from "@/client/routes/resource-location";
import { Failure } from "@/client/ui/failure";
import { buttonStyles, formStyles } from "@vaskel/ui/components/control-styles";

export function NewServerForm({ close }: { close: () => void }) {
  const { t } = useI18n();
  const { canUseNetwork } = useAccess();
  const [attempt, setAttempt] = useState<{
    commandId: string;
    name: string;
    firstChannelName?: string;
  } | null>(null);
  const user = useUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: async ({
      name,
      firstRoom,
    }: {
      name: string;
      firstRoom: string;
    }) => {
      const body = attempt ?? {
        commandId: crypto.randomUUID(),
        name: name.trim(),
        ...(firstRoom.trim() ? { firstChannelName: firstRoom.trim() } : {}),
      };
      setAttempt(body);
      const result = await api.createServer({ body: body });
      await client.invalidateQueries({
        queryKey: directoryKey(user.userId),
      });
      await navigate({
        ...resourceLocation(result.owner, result.channelId),
        search: {},
      });
      close();
    },
  });
  const form = useAppForm({
    defaultValues: { name: "", firstRoom: "" },
    listeners: { onChange: () => setAttempt(null) },
    onSubmit: ({ value }) => {
      create.mutate(value);
    },
  });
  const name = useStore(form.store, (state) => state.values.name);
  return (
    <Form className={formStyles} form={form}>
      <form.AppField name="name">
        {(field) => (
          <field.TextField
            label={t("workspace.serverName")}
            placeholder={t("workspace.serverPlaceholder")}
            maxLength={100}
            required
            disabled={!canUseNetwork || create.isPending}
          />
        )}
      </form.AppField>
      <form.AppField name="firstRoom">
        {(field) => (
          <field.TextField
            label={t("workspace.firstRoomName")}
            placeholder="general"
            maxLength={100}
            disabled={!canUseNetwork || create.isPending}
            hint={t("workspace.firstRoomHint")}
          />
        )}
      </form.AppField>
      <Failure error={create.error} />
      <button
        className={buttonStyles({ variant: "primary" })}
        disabled={!canUseNetwork || create.isPending || !name.trim()}
      >
        {create.isPending
          ? t("workspace.creating")
          : t("workspace.createServerTitle")}
      </button>
    </Form>
  );
}
