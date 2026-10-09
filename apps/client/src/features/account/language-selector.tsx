import { useId } from "react";
import { errorMessage, isCancellation } from "@/client/api/errors";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { languageOptions } from "@/client/features/i18n/locale";
import { fieldStyles, labelStyles } from "@vaskel/ui/components/control-styles";
import { UiLanguageSchema } from "@vaskel/contracts/preferences";
import { usePreferencesMutation } from "./use-preferences";

export function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const { t, text } = useI18n();
  const mutation = usePreferencesMutation();
  const id = useId();
  const noticeId = `${id}-notice`;
  const error =
    mutation.error && !isCancellation(mutation.error)
      ? text(errorMessage(mutation.error))
      : null;
  const status = !canUseNetwork
    ? t("account.languageOffline")
    : mutation.isPending
      ? t("account.languageSaving")
      : error
        ? error
        : mutation.isSuccess
          ? t("account.languageSaved")
          : user.preferences.language === null
            ? t("account.languageFallback")
            : null;
  return (
    <div className={compact ? "py-2" : "max-w-md"}>
      <label className={labelStyles} htmlFor={id}>
        {t("account.language")}
      </label>
      <select
        id={id}
        className={`${fieldStyles} mt-2`}
        value={user.preferences.language ?? ""}
        disabled={!canUseNetwork || mutation.isPending}
        aria-describedby={status ? noticeId : undefined}
        aria-busy={mutation.isPending}
        onChange={(event) => {
          const parsed = UiLanguageSchema.safeParse(event.target.value);
          if (parsed.success) mutation.mutate(parsed.data);
        }}
      >
        <option value="" disabled>
          {t("account.languageBrowser")}
        </option>
        {languageOptions.map(({ language, label }) => (
          <option key={language} value={language} lang={language}>
            {label}
          </option>
        ))}
      </select>
      {status && (
        <p
          id={noticeId}
          role="status"
          className={`mt-2 text-caption ${error ? "text-error" : "text-muted"}`}
        >
          {status}
        </p>
      )}
    </div>
  );
}
