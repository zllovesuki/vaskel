import { useId } from "react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { fieldStyles, labelStyles } from "@vaskel/ui/components/control-styles";
import { useTheme, type ThemeChoice } from "@/client/ui/theme";

const choices: readonly ThemeChoice[] = ["system", "light", "dark"];

/** Appearance is a device choice kept in this browser, not an account setting. */
export function ThemeSelector() {
  const { t } = useI18n();
  const [choice, setChoice] = useTheme();
  const id = useId();
  const labels: Record<ThemeChoice, string> = {
    system: t("account.themeSystem"),
    light: t("account.themeLight"),
    dark: t("account.themeDark"),
  };
  return (
    <div className="max-w-md">
      <label className={labelStyles} htmlFor={id}>
        {t("account.appearance")}
      </label>
      <select
        id={id}
        className={`${fieldStyles} mt-2`}
        value={choice}
        onChange={(event) => {
          const next = event.target.value;
          if (choices.includes(next as ThemeChoice))
            setChoice(next as ThemeChoice);
        }}
      >
        {choices.map((value) => (
          <option key={value} value={value}>
            {labels[value]}
          </option>
        ))}
      </select>
      <p className="mt-2 text-caption text-muted">
        {t("account.appearanceHint")}
      </p>
    </div>
  );
}
