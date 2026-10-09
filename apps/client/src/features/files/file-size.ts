import type { UiLanguage } from "@vaskel/contracts/preferences";
import { createFormatters } from "@vaskel/ui/language";

export function fileSize(bytes: number, language: UiLanguage) {
  return createFormatters(language).formatFileSize(bytes);
}
