import { setupI18n, type I18n as LinguiI18n } from "@lingui/core";
import type { UiLanguage } from "@vaskel/contracts/preferences";
import { catalogs } from "./catalogs";
import { createFormatters } from "@vaskel/ui/language";
import type { UiMessage, UiMessageArgs, UiMessageKey } from "./messages";

function createPresentation(runtime: LinguiI18n) {
  const language = runtime.locale as UiLanguage;
  function t<Key extends UiMessageKey>(...args: UiMessageArgs<Key>): string {
    const [key, params] = args;
    return runtime._(key, params);
  }
  function text(descriptor: UiMessage): string {
    return runtime._(
      descriptor.key,
      "params" in descriptor ? descriptor.params : undefined,
    );
  }
  return { runtime, language, t, text, ...createFormatters(language) };
}

export function createI18n(language: UiLanguage) {
  return bindI18n(
    setupI18n({
      locale: language,
      messages: { [language]: catalogs[language] },
    }),
  );
}
export type I18n = ReturnType<typeof createPresentation>;

const presentations = new WeakMap<LinguiI18n, I18n>();

/** Share locale formatters across every consumer of one Lingui context. */
export function bindI18n(runtime: LinguiI18n): I18n {
  let value = presentations.get(runtime);
  if (!value || value.language !== runtime.locale) {
    value = createPresentation(runtime);
    presentations.set(runtime, value);
  }
  return value;
}
