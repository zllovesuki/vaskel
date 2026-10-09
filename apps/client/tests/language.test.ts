import { describe, expect, it } from "vitest";
import {
  ApiError,
  NetworkError,
  errorMessage,
  failureMessage,
} from "@/client/api/errors";
import {
  message,
  UiMessageError,
  type UiMessageKey,
} from "@/client/features/i18n/messages";
import { createI18n } from "@/client/features/i18n/render";
import { catalogs } from "@/client/features/i18n/catalogs";
import { UiLanguageSchema } from "@vaskel/contracts/preferences";
import { REACTION_EMOJIS } from "@vaskel/contracts/messaging";
import { initial } from "@vaskel/ui/components/avatar";
import { createFormatters, resolveBrowserLanguage } from "@vaskel/ui/language";

describe("language presentation boundary", () => {
  it("respects ordered browser hints and explicit Chinese scripts before region", () => {
    const cases: [string[], string][] = [
      [["ko-KR", "zh-Hant-CN", "en"], "zh-Hant"],
      [["zh-Hans-TW"], "zh-Hans"],
      [["zh-TW"], "zh-Hant"],
      [["zh-HK"], "zh-Hant"],
      [["zh-MO"], "zh-Hant"],
      [["zh-SG"], "zh-Hans"],
      [["zh-CN"], "zh-Hans"],
      [["zh-Latn-TW", "ja-JP"], "ja"],
      [["invalid_locale", "ja-JP", "zh-TW"], "ja"],
      [["EN-gb"], "en"],
      [["ko-KR", "fr-FR"], "en"],
      [[], "en"],
    ];
    for (const [hints, expected] of cases)
      expect(resolveBrowserLanguage(hints)).toBe(expected);
  });

  it("keeps transport facts while unknown codes and exception messages stay out of presentation", () => {
    const errors = [
      new ApiError("<script>untrusted backend text</script>", 503),
      new ApiError("__proto__", 400),
      new ApiError("constructor", 400),
      new Error("Provider secret and untranslated browser text"),
      { message: "Forged error", code: "forbidden" },
      null,
    ];
    for (const error of errors) {
      expect(errorMessage(error)).toEqual(message("api.unknown"));
      expect(createI18n("en").text(errorMessage(error))).not.toContain(
        "Provider",
      );
    }
    const denied = new ApiError("forbidden", 403, "http");
    expect(errorMessage(denied)).toEqual(message("api.forbidden"));
    expect(denied).toMatchObject({
      code: "forbidden",
      status: 403,
      failure: "http",
    });
    expect(errorMessage(new NetworkError())).toEqual(
      message("api.unavailable"),
    );
    expect(
      errorMessage(new UiMessageError(message("chat.invalidMessage"))),
    ).toEqual(message("chat.invalidMessage"));
  });

  it("renders retained descriptors and untouched user content through every complete catalog", () => {
    const retainedFailure = failureMessage("forbidden");
    const name = "河原 / 山田 / 한글 / <script>";
    const invitation = message("auth.invited", { name });
    const english = createI18n("en").text(retainedFailure);
    for (const language of UiLanguageSchema.options) {
      const i18n = createI18n(language);
      const reference = "9a1234567890abcd-SJC";
      expect(
        i18n.text(
          errorMessage(new ApiError("internal_error", 500, "http", reference)),
        ),
      ).toContain(reference);
      expect(
        errorMessage(new ApiError("forbidden", 403, "http", reference)),
      ).toEqual(message("api.forbidden"));
      expect(Object.keys(catalogs[language]).sort()).toEqual(
        Object.keys(catalogs.en).sort(),
      );
      expect(i18n.text(invitation)).toContain(name);
      expect(i18n.text(retainedFailure)).toBe(i18n.t("api.forbidden"));
      if (language !== "en")
        expect(i18n.text(retainedFailure)).not.toBe(english);
    }
    expect(retainedFailure).toEqual(message("api.forbidden"));
    expect(initial("𠮷田")).toBe("𠮷");
    expect(initial("👩‍💻 Developer")).toBe("👩‍💻");
  });

  it("formats dates and counts with the selected locale, decimal file units and a 24-hour clock outside English", () => {
    const instant = new Date("2026-09-16T12:34:00Z");
    const dateOptions: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    };
    for (const language of UiLanguageSchema.options) {
      const format = createFormatters(language);
      expect(format.formatDateTime(instant, dateOptions)).toBe(
        new Intl.DateTimeFormat(language, dateOptions).format(instant),
      );
      expect(format.formatNumber(1234567.5)).toBe(
        new Intl.NumberFormat(language).format(1234567.5),
      );
      expect(format.formatFileSize(1_500_000)).toBe(
        `${format.formatNumber(1.5)} MB`,
      );
      expect(format.formatFileSize(0)).toBe(`${format.formatNumber(0)} B`);
      const time = format.formatTime(instant);
      if (language === "en") expect(time).toMatch(/AM|PM/);
      else {
        expect(time).toMatch(/^\d{2}:\d{2}$/);
        expect(format.formatDateTime(instant)).toMatch(/\d{2}:\d{2}$/);
      }
    }
  });

  it("uses compiled ICU grammar without interpreting user text or changing another locale", () => {
    const english = createI18n("en");
    const japanese = createI18n("ja");
    const names = "河原 {count, plural, other {injected}} <script> ' #";
    const retained = message("chat.typing", { names, count: 1 });
    expect(english.text(retained)).toBe(`${names} is typing…`);
    expect(japanese.text(retained)).toBe(`${names} が入力中…`);
    expect(english.t("chat.typing", { names, count: 2 })).toBe(
      `${names} are typing…`,
    );
    expect(english.text(retained)).toBe(`${names} is typing…`);
    expect(english.t("chat.roomIntroTitle", { name: "general" })).toBe(
      "Welcome to #general",
    );
    expect(english.t("drafts.clearFailed")).toBe("Couldn't clear this draft.");
    expect(english.t("chat.quotedAttachments", { count: "1" })).toBe(
      "1 attached file · Open the original to view",
    );
    expect(english.t("chat.quotedAttachments", { count: "2" })).toBe(
      "2 attached files · Open the original to view",
    );
    expect(english.t("media.peopleHere", { count: "1", total: 1 })).toBe(
      "1 person is here.",
    );
    expect(english.t("media.peopleHere", { count: "2", total: 2 })).toBe(
      "2 people are here.",
    );
  });

  it("names every allowed reaction through each locale's static catalog", () => {
    for (const language of UiLanguageSchema.options) {
      const { t } = createI18n(language);
      for (const emoji of REACTION_EMOJIS) {
        const name = t(`chat.reaction.${emoji}`);
        expect(name).not.toBe(`chat.reaction.${emoji}`);
        expect(name).not.toBe(emoji);
      }
    }
    expect(createI18n("en").t("chat.reaction.❤️")).toBe("Red heart");
    expect(createI18n("ja").t("chat.reaction.❤️")).toBe("ハート");
  });

  it("does not introduce untranslated or renamed parameters in another catalog", () => {
    const english = createI18n("en");
    for (const language of UiLanguageSchema.options) {
      const translated = createI18n(language);
      for (const key of Object.keys(catalogs.en) as UiMessageKey[]) {
        for (const count of [0, 1, 2]) {
          const sourceParameters = new Set<string>();
          const translatedParameters = new Set<string>();
          const values = (seen: Set<string>) =>
            new Proxy<Record<string, string | number>>(
              {},
              {
                get: (_target, name: string) => {
                  seen.add(name);
                  return name === "count" || name === "total"
                    ? count
                    : "河原 <script> {user text}";
                },
              },
            );
          english.runtime._(key, values(sourceParameters));
          const rendered = translated.runtime._(
            key,
            values(translatedParameters),
          );
          expect(rendered, `${language}: ${key}`).not.toBe(key);
          for (const name of translatedParameters)
            expect(
              sourceParameters.has(name),
              `${language}: ${key}.${name}`,
            ).toBe(true);
        }
      }
    }
  });
});
