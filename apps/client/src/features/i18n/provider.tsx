import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccess } from "@/client/features/cache/access/context";
import { createI18n } from "./render";
import { I18nProvider } from "@lingui/react";
import { resolveBrowserLanguage } from "@vaskel/ui/language";

const browserLanguage = () => resolveBrowserLanguage(navigator.languages);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { view } = useAccess();
  const [fallback, setFallback] = useState(browserLanguage);
  const preferred =
    view.kind === "account"
      ? view.user.preferences.language
      : view.kind === "cached"
        ? view.account?.displayLanguage?.language
        : null;
  const language = preferred ?? fallback;
  const value = useMemo(() => createI18n(language), [language]);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    const changed = () => setFallback(browserLanguage());
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  return <I18nProvider i18n={value.runtime}>{children}</I18nProvider>;
}
