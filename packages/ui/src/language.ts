import type { UiLanguage } from "@vaskel/contracts/preferences";

/** Browser hints are presentation only and are never saved as a preference. */
export function resolveBrowserLanguage(
  languages: readonly string[],
): UiLanguage {
  for (const tag of languages) {
    try {
      const locale = new Intl.Locale(tag);
      if (locale.language === "en" || locale.language === "ja")
        return locale.language;
      if (locale.language === "zh") {
        if (locale.script === "Hans") return "zh-Hans";
        if (locale.script === "Hant") return "zh-Hant";
        // An explicit unselected script must not be inferred from its region.
        if (locale.script) continue;
        return ["TW", "HK", "MO"].includes(locale.region ?? "")
          ? "zh-Hant"
          : "zh-Hans";
      }
    } catch {
      // Malformed and unsupported hints fall through the ordered browser list.
    }
  }
  return "en";
}

/**
 * Number, date and size formatting for one interface language, shared by the
 * app and the landing page's preview so both print the same clock.
 */
export function createFormatters(language: UiLanguage) {
  // This factory lives for one selected locale. Reuse formatters across timeline
  // rows and file labels instead of constructing an Intl formatter per render.
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => {
    const key = JSON.stringify(options ?? {});
    let formatter = numbers.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(language, options);
      numbers.set(key, formatter);
    }
    return formatter.format(value);
  };
  // Chinese and Japanese readers expect a 24-hour clock; the locale's own
  // short time style would spell out day periods (清晨5:07) of varying width.
  const clock: Intl.DateTimeFormatOptions =
    language === "en"
      ? { timeStyle: "short" }
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const dateAndTime: Intl.DateTimeFormatOptions =
    language === "en"
      ? { dateStyle: "medium", timeStyle: "short" }
      : { year: "numeric", month: "short", day: "numeric", ...clock };
  const formatDateTime = (
    value: number | Date | string,
    options: Intl.DateTimeFormatOptions = dateAndTime,
  ) => {
    const key = JSON.stringify(options);
    let formatter = dates.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(language, options);
      dates.set(key, formatter);
    }
    return formatter.format(new Date(value));
  };
  return {
    formatNumber,
    formatDateTime,
    formatDate: (
      value: number | Date | string,
      options?: Intl.DateTimeFormatOptions,
    ) => formatDateTime(value, options ?? { dateStyle: "medium" }),
    formatTime: (
      value: number | Date | string,
      options?: Intl.DateTimeFormatOptions,
    ) => formatDateTime(value, options ?? clock),
    // Decimal units, as chat products and operating systems show them.
    formatFileSize: (bytes: number) => {
      const units = ["B", "KB", "MB", "GB"] as const;
      const exponent = Math.min(
        units.length - 1,
        Math.max(0, Math.floor(Math.log10(Math.max(1, bytes)) / 3)),
      );
      const amount = formatNumber(bytes / 1_000 ** exponent, {
        maximumFractionDigits: exponent === 0 ? 0 : 1,
      });
      return `${amount} ${units[exponent]}`;
    },
  };
}
