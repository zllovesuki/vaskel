import { TextField } from "@/client/ui/forms/controls";
import { useI18n } from "@/client/features/i18n/use-i18n";

/** These fields consume the surrounding AppField; workflows own their form values. */
export function EmailField() {
  const { t } = useI18n();
  return (
    <TextField
      label={t("auth.email")}
      type="email"
      autoComplete="email"
      required
      maxLength={254}
    />
  );
}

export function PasswordField({ purpose }: { purpose: "new" | "current" }) {
  const { t } = useI18n();
  return (
    <TextField
      label={t("auth.password")}
      type="password"
      autoComplete={purpose === "new" ? "new-password" : "current-password"}
      required
      minLength={purpose === "new" ? 12 : 1}
      maxLength={256}
      hint={purpose === "new" && t("auth.passwordHint")}
    />
  );
}

export function DisplayNameField() {
  const { t } = useI18n();
  return (
    <TextField
      label={t("auth.displayName")}
      autoComplete="nickname"
      required
      maxLength={80}
    />
  );
}

export function SetupKeyField() {
  const { t } = useI18n();
  return (
    <TextField
      label={t("auth.setupKey")}
      type="password"
      autoComplete="off"
      required
      minLength={43}
      maxLength={128}
    />
  );
}
