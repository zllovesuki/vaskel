import { test, expect } from "@tests/e2e/fixtures";

test.use({ seeded: false });

test("the saved theme applies under CSP before the application can mount", async ({
  app,
  browser,
}) => {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({
      colorScheme: theme === "dark" ? "light" : "dark",
      serviceWorkers: "block",
    });
    try {
      await page.addInitScript(
        (choice) => localStorage.setItem("vaskel.theme", choice),
        theme,
      );
      await page.route("**/assets/*.js", (route) => route.abort());
      const violations: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy"))
          violations.push(message.text());
      });
      const response = await page.goto(`${app.origin}/sign-in`);
      expect(response?.headers()["content-security-policy"]).toContain(
        "script-src 'self'",
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
      await expect(page.locator("#root")).toBeEmpty();
      expect(violations).toEqual([]);
    } finally {
      await page.close();
    }
  }
});
