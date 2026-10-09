import { test, expect } from "@tests/e2e/fixtures";

// A route chunk that no longer loads, as in a tab left open across a
// deployment, is a genuine failure: the router reloads once, then renders the
// error screen. Password recovery is the lazy entry page a visitor can reach.
const recoveryChunk = /\/assets\/password-recovery-[^/]*\.js$/;

test.describe("malformed link values", () => {
  test.use({ seeded: false });
  test("open the destination instead of a dead end", async ({ app, page }) => {
    await page.goto(`${app.origin}/sign-in?at=not-a-number&q=2024&token=null`);
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "This page couldn’t open" }),
    ).toHaveCount(0);
  });
});

for (const scenario of [
  {
    locale: "en-US",
    language: "en",
    viewport: { width: 1280, height: 900 },
    heading: "This page couldn’t open",
    reload: "Reload",
    home: "Return to vaskel.",
    signIn: "Sign in",
  },
  {
    locale: "ja-JP",
    language: "ja",
    viewport: { width: 390, height: 844 },
    heading: "ページを開けませんでした",
    reload: "再読み込み",
    home: "vaskel. に戻る",
    signIn: "ログイン",
  },
]) {
  test.describe(scenario.locale, () => {
    test.use({
      seeded: false,
      locale: scenario.locale,
      viewport: scenario.viewport,
    });
    test("a failed route chunk has localized reload and home recovery", async ({
      app,
      page,
    }) => {
      await page.route(recoveryChunk, (route) => route.abort());
      await page.goto(`${app.origin}/forgot-password`);
      const heading = page.getByRole("heading", { name: scenario.heading });
      await expect(heading).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        scenario.language,
      );
      if (scenario.language === "ja")
        await expect(heading).toHaveCSS("font-family", /Plyra Sans JP/);
      await expect(page.getByText("Something went wrong!")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Show Error" }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(scenario.viewport.width);
      await Promise.all([
        page.waitForEvent(
          "framenavigated",
          (frame) => frame === page.mainFrame(),
        ),
        page
          .getByRole("button", { name: scenario.reload, exact: true })
          .click(),
      ]);
      await expect(heading).toBeVisible();
      await page
        .getByRole("link", { name: scenario.home, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: scenario.signIn, exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${app.origin}/sign-in`);
    });
  });
}
