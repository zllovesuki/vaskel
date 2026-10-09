import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/client/api/contract";
import { invitesKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { message, type UiMessage } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Form } from "@/client/ui/forms/controls";
import { useAppForm } from "@/client/ui/forms/use-app-form";
import { Failure } from "@/client/ui/failure";
import {
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
  formStyles,
  labelStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";

export function InviteForm({ serverId }: { serverId: string }) {
  const { t, text, formatNumber, formatDateTime } = useI18n();
  const { canUseNetwork } = useAccess();
  const user = useUser();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<UiMessage | null>(null);
  const create = useMutation({
    mutationFn: ({ days, uses }: { days: string; uses: string }) =>
      api.createInvite({
        params: { id: serverId },
        body: {
          expiresAt: Date.now() + Number(days) * 86_400_000,
          maxUses: Number(uses),
        },
      }),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: invitesKey(user.userId, serverId),
      }),
  });
  const form = useAppForm({
    defaultValues: { days: "7", uses: "1" },
    onSubmit: ({ value }) => {
      setCopied(false);
      create.mutate(value);
    },
  });
  const link = create.data
    ? `${location.origin}/invite?token=${encodeURIComponent(create.data.token)}`
    : "";
  return (
    <Form className={formStyles} form={form}>
      {create.data ? (
        <>
          <p className="text-muted">
            {t("workspace.invitationCapacity", {
              count: create.data.maxUses,
              countText: formatNumber(create.data.maxUses),
            })}
          </p>
          <label className={labelStyles}>
            {t("workspace.invitationLink")}
            <input
              className={fieldStyles}
              readOnly
              value={link}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            type="button"
            className={buttonStyles({ variant: "primary" })}
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() => {
                  setCopied(true);
                  setCopyError(null);
                })
                .catch(() => setCopyError(message("workspace.copyFallback")));
            }}
          >
            {copied ? t("workspace.copied") : t("workspace.copyInvite")}
          </button>
          {copyError && (
            <p role="status" className={fieldHintStyles}>
              {text(copyError)}
            </p>
          )}
          <p className={fieldHintStyles}>
            {t("workspace.invitationExpiry", {
              date: formatDateTime(create.data.expiresAt),
            })}
          </p>
          <button
            type="button"
            className={textButtonStyles()}
            onClick={() => create.reset()}
          >
            {t("workspace.createAnotherInvitation")}
          </button>
        </>
      ) : (
        <>
          <form.AppField name="days">
            {(field) => (
              <field.SelectField
                label={t("workspace.expiresIn")}
                disabled={!canUseNetwork}
              >
                <option value="1">
                  {t("workspace.days", {
                    count: 1,
                    countText: formatNumber(1),
                  })}
                </option>
                <option value="7">
                  {t("workspace.days", {
                    count: 7,
                    countText: formatNumber(7),
                  })}
                </option>
                <option value="30">
                  {t("workspace.days", {
                    count: 30,
                    countText: formatNumber(30),
                  })}
                </option>
              </field.SelectField>
            )}
          </form.AppField>
          <form.AppField name="uses">
            {(field) => (
              <field.TextField
                label={t("workspace.numberPeople")}
                type="number"
                min={1}
                max={100}
                disabled={!canUseNetwork}
                required
              />
            )}
          </form.AppField>
          <Failure error={create.error} />
          <button
            className={buttonStyles({ variant: "primary" })}
            disabled={!canUseNetwork || create.isPending}
          >
            {create.isPending
              ? t("workspace.creating")
              : t("workspace.createInvitation")}
          </button>
        </>
      )}
    </Form>
  );
}
