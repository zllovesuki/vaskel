import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openRoom } from "@/site/preview/preview";
import { createFormatters } from "@vaskel/ui/language";
import {
  LANGUAGES,
  STRINGS,
  t,
  today,
  type Language,
} from "@/site/preview/strings";
import { scenarios } from "@/site/page/scenarios";
import { transcript } from "@/site/page/transcript";

const repository = new URL("../../../", import.meta.url);
const json = (path: string) =>
  JSON.parse(readFileSync(new URL(path, repository), "utf8")) as never;

describe("preview strings", () => {
  it("match the client's catalogs for every language", () => {
    const catalogs = Object.fromEntries(
      LANGUAGES.map((language) => [
        language,
        json(
          `apps/client/src/features/i18n/locales/${language}.json`,
        ) as Record<string, string>,
      ]),
    ) as Record<Language, Record<string, string>>;
    for (const [key, entry] of Object.entries(STRINGS)) {
      for (const language of LANGUAGES) {
        const expected = catalogs[language][key];
        // The app's plural message carries one branch the preview needs.
        const message =
          key === "chat.typing" && language === "en"
            ? "{names} is typing…"
            : expected;
        expect(entry[language], `${key} ${language}`).toBe(message);
      }
    }
  });

  it("fill placeholders and format times per language", () => {
    expect(t("ja", "workspace.inTheCall", { count: 5 })).toBe("5 人が通話中");
    expect(t("zh-Hant", "chat.messageTo", { label: "#general" })).toBe(
      "傳送訊息至 #general",
    );
    // Message times come from the app's own formatters.
    expect(createFormatters("en").formatTime("2026-09-18T20:58:00")).toBe(
      "8:58 PM",
    );
    expect(createFormatters("ja").formatTime("2026-09-18T20:58:00")).toBe(
      "20:58",
    );
    expect(today("zh-Hant")).toBe("今天");
  });
});

describe("opening a room", () => {
  it("clears only that room's unread mark", () => {
    const unread = new Set<"memes" | "shirasu">(["memes", "shirasu"]);
    const next = openRoom(unread, "memes");
    expect([...next]).toEqual(["shirasu"]);
    expect(openRoom(next, "general")).toBe(next);
  });
});

describe("the agent session", () => {
  it("runs only commands INSTALL.md gives", () => {
    const install = readFileSync(new URL("INSTALL.md", repository), "utf8");
    const commands = transcript.flatMap((turn) =>
      turn.kind === "tool" && turn.tool === "Bash"
        ? turn.input.split(" && ")
        : [],
    );
    expect(commands).toContain(
      "pnpm run deploy:production --secrets-file .local/install/secrets.json",
    );
    for (const command of commands) expect(install, command).toContain(command);
  });
});

describe("cost figures", () => {
  it("equal docs/cost-scenarios.json", () => {
    const models = json("docs/cost-scenarios.json") as {
      monthly_usd: Record<string, number>;
      modeled_subtotal_usd: number;
      derived: { realtime_egress_gb: number };
    }[];
    expect(models).toHaveLength(2);
    for (const [scenario, model] of [
      [scenarios.small, models[0]!],
      [scenarios.busy, models[1]!],
    ] as const) {
      const usd = model.monthly_usd;
      expect(scenario.workers).toBe(usd.workers);
      expect(scenario.durable).toBeCloseTo(usd.do_compute! + usd.do_sql!, 2);
      expect(scenario.d1).toBe(usd.d1);
      expect(scenario.r2).toBe(usd.r2);
      expect(scenario.email).toBe(usd.email);
      expect(scenario.sfu).toBeCloseTo(usd.sfu_and_turn!, 2);
      expect(scenario.egressGb).toBe(
        Math.round(model.derived.realtime_egress_gb),
      );
      expect(scenario.subtotal).toBe(model.modeled_subtotal_usd);
    }
  });
});
