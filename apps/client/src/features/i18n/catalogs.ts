import type { Messages } from "@lingui/core";
import type { UiLanguage } from "@vaskel/contracts/preferences";
import { messages as en } from "./locales/en.json?lingui";
import { messages as ja } from "./locales/ja.json?lingui";
import { messages as zhHans } from "./locales/zh-Hans.json?lingui";
import { messages as zhHant } from "./locales/zh-Hant.json?lingui";

// All launch locales ship in the offline shell; changing language needs no fetch.
export const catalogs: Record<UiLanguage, Messages> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ja,
};
