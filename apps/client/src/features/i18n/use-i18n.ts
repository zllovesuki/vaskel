import { useLingui } from "@lingui/react";
import { bindI18n } from "./render";

export function useI18n() {
  const { i18n } = useLingui();
  return bindI18n(i18n);
}
