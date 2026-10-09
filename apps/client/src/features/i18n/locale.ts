import type { UiLanguage } from "@vaskel/contracts/preferences";

export const languageOptions: readonly {
  language: UiLanguage;
  label: string;
}[] = [
  { language: "en", label: "English" },
  { language: "zh-Hans", label: "简体中文" },
  { language: "zh-Hant", label: "繁體中文" },
  { language: "ja", label: "日本語" },
];
