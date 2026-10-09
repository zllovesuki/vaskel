import { NavigationToggle } from "@vaskel/ui/components/home";
import {
  Bone,
  FieldSkeleton,
  Line,
  Placeholder,
} from "@/client/ui/loading-skeleton";
import { Form } from "@/client/ui/forms/controls";
import { Fragment } from "react";
import { ImagePlus } from "lucide-react";
import { Avatar } from "@vaskel/ui/components/avatar";
import { SettingsSection } from "@/client/ui/settings-section";
import { HostPeople } from "./host-people";
import { HostStorage } from "./host-storage";
import { HostSearchIndex } from "./host-search-index";
import { apiFailure } from "@/client/api/errors";

import { useAppForm } from "@/client/ui/forms/use-app-form";

import { useStore } from "@tanstack/react-form";
import { useId, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  INSTANCE_ICON_BYTE_LIMIT,
  InvitePolicySchema,
  type InvitePolicy,
} from "@vaskel/contracts/instance";
import { directoryKey, errorMessage } from "@/client/api/client";
import {
  INSTANCE_ICON_PATH,
  operatorInstanceOptions,
  publicInstanceOptions,
  updateInstance,
  uploadInstanceIcon,
  type OperatorInstance,
} from "@/client/api/instance";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonRowStyles,
  buttonStyles,
  chatHeaderStyles,
  fieldHintStyles,
  formStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";

import {
  settingsBodyStyles,
  settingsColumnStyles,
  settingsListStyles,
  settingsRowStyles,
} from "@/client/ui/settings-section";
import { ICON_ACCEPT, iconFileProblem } from "./host-model";

/**
 * The icon of this vaskel., or its first grapheme on a neutral square until the
 * host chooses one. Places stay neutral; colour identifies people.
 */
function InstanceIcon({
  name,
  hasIcon,
  version,
  size,
}: {
  name: string;
  hasIcon: boolean;
  version: number;
  size: "header" | "large";
}) {
  const { t } = useI18n();
  const dimension = size === "large" ? "size-16" : "size-9";
  return hasIcon ? (
    <img
      src={`${INSTANCE_ICON_PATH}?v=${version}`}
      // Beside the name in the header the image is decoration; in the icon
      // control it is the current choice.
      alt={size === "large" ? t("host.iconCurrent") : ""}
      className={`${dimension} shrink-0 rounded-[30%] border border-line object-cover`}
    />
  ) : (
    <Avatar
      name={name}
      size={size === "large" ? 16 : 9}
      className="border border-line"
    />
  );
}

/** The settings of this vaskel. itself, for the one account that runs it. */
export function HostPage({ onNavigation }: { onNavigation: () => void }) {
  const { t, text, formatFileSize } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const client = useQueryClient();
  const operator = user.isOperator;
  const options = operatorInstanceOptions(user.userId);
  const instance = useQuery({
    ...options,
    enabled: canUseNetwork && operator,
  });
  const [iconProblem, setIconProblem] = useState<"type" | "size" | null>(null);
  const [iconVersion, setIconVersion] = useState(0);
  const iconHintId = useId();
  const accept = (view: OperatorInstance) => {
    client.setQueryData(options.queryKey, view);
    // The sign-in screen reads the same name and icon from the public view.
    void client.invalidateQueries({
      queryKey: publicInstanceOptions().queryKey,
    });
  };
  const save = useMutation({
    mutationKey: [...options.queryKey, "save"],
    networkMode: "always",
    retry: false,
    mutationFn: updateInstance,
    onSuccess: (view) => {
      accept(view);
      form.reset({ name: view.name, invitePolicy: view.invitePolicy });
      // The host policy contributes to every circle's effective invite action.
      void client.invalidateQueries({
        queryKey: directoryKey(user.userId),
      });
    },
  });
  const icon = useMutation({
    mutationKey: [...options.queryKey, "icon"],
    networkMode: "always",
    retry: false,
    mutationFn: uploadInstanceIcon,
    onSuccess: (view) => {
      accept(view);
      setIconVersion((version) => version + 1);
    },
  });
  const form = useAppForm({
    defaultValues: {
      name: instance.data?.name ?? "",
      invitePolicy: instance.data?.invitePolicy ?? "",
    },
    onSubmit: ({ value }) => {
      const name = value.name.trim();
      const policy = InvitePolicySchema.safeParse(value.invitePolicy);
      if (name && policy.success)
        save.mutate({ name, invitePolicy: policy.data });
    },
  });
  const name = useStore(form.store, (state) => state.values.name);
  const edited = useStore(form.store, (state) => state.isDirty);
  const policies = InvitePolicySchema.options;
  const policyLabels: Record<InvitePolicy, string> = {
    members: t("host.invitePolicyMembers"),
    owners: t("host.invitePolicyOwners"),
  };
  const policyHints: Record<InvitePolicy, string> = {
    members: t("host.invitePolicyMembersHint"),
    owners: t("host.invitePolicyOwnersHint"),
  };
  function chooseIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clearing the control lets the same file be chosen again after a refusal.
    event.target.value = "";
    if (!file) return;
    icon.reset();
    const problem = iconFileProblem(file);
    setIconProblem(problem);
    if (!problem) icon.mutate(file);
  }
  const iconUnreadable =
    apiFailure(icon.error) && apiFailure(icon.error)?.code === "invalid_input";
  const iconBlocked = !canUseNetwork || !instance.data || icon.isPending;
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("workspace.yourVaskel")}
    >
      <header className={chatHeaderStyles}>
        <NavigationToggle
          action="open"
          label={t("chat.openConversations")}
          onClick={onNavigation}
        />
        {operator && instance.data && (
          <InstanceIcon
            name={instance.data.name}
            hasIcon={instance.data.hasIcon}
            version={iconVersion}
            size="header"
          />
        )}
        {operator && instance.isPending && canUseNetwork && (
          <Bone className="size-9 shrink-0 rounded-[30%]" />
        )}
        <div className="mr-auto min-w-0">
          <h1 className="text-base font-semibold">
            {t("workspace.yourVaskel")}
          </h1>
          {operator && instance.data && (
            <p className="truncate text-caption text-muted">
              {instance.data.name}
            </p>
          )}
          {operator && instance.isPending && canUseNetwork && (
            <Line size="caption" width="w-28" />
          )}
        </div>
      </header>
      <div className={settingsBodyStyles}>
        <div className={settingsColumnStyles}>
          {!operator ? (
            <p
              role="alert"
              className={noticeStyles({ error: true, className: "mt-5" })}
            >
              {t("api.forbidden")}
            </p>
          ) : (
            <>
              {!canUseNetwork && (
                <p role="status" className="mt-5 text-caption text-muted">
                  {t("host.offline")}
                </p>
              )}
              <SettingsSection
                title={t("host.identity")}
                description={t("host.description")}
              >
                {instance.error && (
                  <p role="alert" className={noticeStyles({ error: true })}>
                    {text(errorMessage(instance.error))}
                  </p>
                )}
                <Form className={formStyles} form={form}>
                  {instance.isPending && canUseNetwork ? (
                    <Placeholder
                      label={t("workspace.loading")}
                      kind="form"
                      className={formStyles}
                    >
                      <FieldSkeleton
                        label={t("host.instanceName")}
                        hint={t("host.instanceNameHint")}
                      />
                      <FieldSkeleton label={t("host.invitePolicy")} />
                    </Placeholder>
                  ) : (
                    <>
                      <form.AppField name="name">
                        {(field) => (
                          <field.TextField
                            label={t("host.instanceName")}
                            disabled={!instance.data || save.isPending}
                            required
                            maxLength={80}
                            hint={t("host.instanceNameHint")}
                          />
                        )}
                      </form.AppField>
                      <form.AppField name="invitePolicy">
                        {(field) => (
                          <field.SelectField
                            label={t("host.invitePolicy")}
                            disabled={!instance.data || save.isPending}
                          >
                            {!instance.data && <option value="" disabled />}
                            {policies.map((policy) => (
                              <option key={policy} value={policy}>
                                {policyLabels[policy]}
                              </option>
                            ))}
                          </field.SelectField>
                        )}
                      </form.AppField>
                    </>
                  )}
                  <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
                    {policies.map((policy) => (
                      <Fragment key={policy}>
                        <dt className="font-medium">{policyLabels[policy]}</dt>
                        <dd className="text-muted">{policyHints[policy]}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  {save.error && (
                    <p role="alert" className={noticeStyles({ error: true })}>
                      {text(errorMessage(save.error))}
                    </p>
                  )}
                  {save.isSuccess && !edited && (
                    <p role="status" className={noticeStyles()}>
                      {t("host.saved")}
                    </p>
                  )}
                  <div>
                    <button
                      className={buttonStyles({ variant: "primary" })}
                      disabled={
                        !canUseNetwork ||
                        !instance.data ||
                        !name.trim() ||
                        save.isPending
                      }
                    >
                      {save.isPending ? t("account.saving") : t("host.save")}
                    </button>
                  </div>
                </Form>
                {/*
                 * The icon saves on choice; the hairline keeps it apart from
                 * Save. The picker is the browser's, opened from a styled label
                 * around a visually hidden file input, so keyboard focus and
                 * the disabled state show on the label.
                 */}
                <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
                  {instance.data && (
                    <InstanceIcon
                      name={instance.data.name}
                      hasIcon={instance.data.hasIcon}
                      version={iconVersion}
                      size="large"
                    />
                  )}
                  {instance.isPending && canUseNetwork && (
                    <Bone className="size-16 shrink-0 rounded-[30%]" />
                  )}
                  <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
                    <span className="text-ui font-medium">
                      {t("host.icon")}
                    </span>
                    <div className={buttonRowStyles}>
                      <label
                        className={buttonStyles({
                          size: "small",
                          className:
                            "relative cursor-pointer has-[:disabled]:cursor-not-allowed has-[:disabled]:bg-subtle has-[:disabled]:text-muted has-[:disabled]:shadow-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                        })}
                      >
                        <ImagePlus className="size-4" aria-hidden="true" />
                        {instance.data?.hasIcon
                          ? t("host.replaceImage")
                          : t("host.chooseImage")}
                        <input
                          type="file"
                          className="sr-only"
                          accept={ICON_ACCEPT}
                          aria-describedby={iconHintId}
                          disabled={iconBlocked}
                          onChange={chooseIcon}
                        />
                      </label>
                      {icon.isPending && (
                        <span role="status" className="text-caption text-muted">
                          {t("host.iconUploading")}
                        </span>
                      )}
                    </div>
                    <span id={iconHintId} className={fieldHintStyles}>
                      {t("host.iconHint", {
                        size: formatFileSize(INSTANCE_ICON_BYTE_LIMIT),
                      })}
                    </span>
                  </div>
                </div>
                {iconProblem && (
                  <p role="alert" className={noticeStyles({ error: true })}>
                    {iconProblem === "size"
                      ? t("host.iconTooLarge", {
                          size: formatFileSize(INSTANCE_ICON_BYTE_LIMIT),
                        })
                      : t("host.iconWrongType")}
                  </p>
                )}
                {icon.error && (
                  <p role="alert" className={noticeStyles({ error: true })}>
                    {iconUnreadable
                      ? t("host.iconUnreadable")
                      : text(errorMessage(icon.error))}
                  </p>
                )}
                {icon.isSuccess && (
                  <p role="status" className={noticeStyles()}>
                    {t("host.iconSaved")}
                  </p>
                )}
              </SettingsSection>
              <SettingsSection title={t("host.people")} width="full">
                <HostPeople />
              </SettingsSection>
              <SettingsSection
                title={t("host.storage")}
                description={t("host.storageDescription")}
              >
                <HostStorage />
              </SettingsSection>
              <SettingsSection title={t("host.maintenance")}>
                <div className={settingsListStyles}>
                  <div className={settingsRowStyles}>
                    <div className="min-w-0 flex-1 basis-64">
                      <h3 className="text-ui font-medium">
                        {t("host.version")}
                      </h3>
                      <p className={`${fieldHintStyles} mt-1`}>
                        {t("host.versionHint")}
                      </p>
                    </div>
                    {/* The instance read's own failure is the alert above. */}
                    {instance.data?.tag ? (
                      <p className="font-mono text-ui">{instance.data.tag}</p>
                    ) : instance.isPending && canUseNetwork ? (
                      <Line width="w-16" />
                    ) : (
                      <p className="text-ui text-muted">
                        {instance.data
                          ? t("host.versionMissing")
                          : t("host.versionUnavailable")}
                      </p>
                    )}
                  </div>
                  <HostSearchIndex />
                </div>
              </SettingsSection>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
