import { test, expect } from "@tests/e2e/fixtures";

test.use({ seeded: false });

test("the client loads IBM Plex and the regional Plyra faces from its own origin", async ({
  app,
  browser,
}) => {
  for (const [locale, language, family, sample] of [
    ["en-US", "en", "IBM Plex Sans Var", "vaskel"],
    ["zh-CN", "zh-Hans", "Plyra Sans SC", "简体中文"],
    ["zh-TW", "zh-Hant", "Plyra Sans TC", "繁體中文"],
    ["ja-JP", "ja", "Plyra Sans JP", "日本語"],
  ] as const) {
    const page = await browser.newPage({ locale });
    try {
      const errors: string[] = [];
      const fontUrls: string[] = [];
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          message.text().includes("Content Security Policy")
        )
          errors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.url().endsWith(".woff2") && response.ok())
          fontUrls.push(response.url());
      });
      await page.goto(`${app.origin}/sign-in`);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(page.locator("html")).toHaveCSS(
        "font-family",
        new RegExp(family),
      );
      await expect
        .poll(() =>
          page.evaluate(
            (name) =>
              [...document.fonts].some((font) => font.family.includes(name)),
            family,
          ),
        )
        .toBe(true);
      const loaded = await page.evaluate(
        async ({ family, sample }) =>
          (await document.fonts.load(`16px "${family}"`, sample)).length,
        { family, sample },
      );
      expect(loaded).toBeGreaterThan(0);
      expect(fontUrls.length).toBeGreaterThan(0);
      expect(fontUrls.every((url) => new URL(url).origin === app.origin)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
});
