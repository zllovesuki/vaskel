import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-json";

export default defineConfig({
  locales: ["en", "zh-Hans", "zh-Hant", "ja"],
  sourceLocale: "en",
  catalogs: [
    {
      path: "<rootDir>/src/features/i18n/locales/{locale}",
      include: ["<rootDir>/src"],
    },
  ],
  // Catalogs are authored by explicit ID; compilation never rewrites them.
  format: formatter({ style: "minimal", origins: false, lineNumbers: false }),
  compileNamespace: "ts",
  fallbackLocales: false,
});
