import { useContext, useEffect, useMemo } from "react";
import { LinguiContext } from "@lingui/react";
import { resolveBrowserLanguage } from "@vaskel/ui/language";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { bindI18n, createI18n } from "@/client/features/i18n/render";

/** The root layout can fail before account and language providers mount. */
export function RouteErrorScreen() {
  const context = useContext(LinguiContext);
  const { language, t } = useMemo(
    () =>
      context
        ? bindI18n(context.i18n)
        : createI18n(resolveBrowserLanguage(navigator.languages)),
    [context],
  );
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return (
    <main
      lang={language}
      className="flex min-h-svh flex-col bg-page p-6 sm:px-12 sm:py-8"
    >
      <section
        className="m-auto w-full max-w-[25rem] py-10 sm:py-16"
        aria-labelledby="route-error-title"
      >
        <h1 id="route-error-title" className="mb-4 text-balance">
          {t("routes.failed")}
        </h1>
        <p className="mb-7 leading-relaxed text-pretty text-muted">
          {t("routes.recovery")}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className={buttonStyles({ variant: "primary" })}
            onClick={() => window.location.reload()}
          >
            {t("routes.reload")}
          </button>
          <a href="/" className={buttonStyles()}>
            {t("routes.return")}
          </a>
        </div>
      </section>
    </main>
  );
}
