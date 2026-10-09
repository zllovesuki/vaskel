import { performance as nodePerformance } from "node:perf_hooks";
import { test, expect, roomPath } from "@tests/e2e/fixtures";

test("records cold sign-in and chat startup on local Chromium", async ({
  app,
  browser,
}, testInfo) => {
  const room = await app.room("Startup measurement");
  const message = await app.send(app.owner, room, "Cold chat is ready");
  const measurements = [];
  for (const screen of ["sign-in", "chat"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    try {
      if (screen === "chat")
        await context.addCookies(
          app.member.cookie.split("; ").map((cookie) => {
            const equals = cookie.indexOf("=");
            return {
              name: cookie.slice(0, equals),
              value: cookie.slice(equals + 1),
              url: app.origin,
            };
          }),
        );
      const page = await context.newPage();
      const started = nodePerformance.now();
      await page.goto(
        `${app.origin}${screen === "chat" ? roomPath(room) : "/sign-in"}`,
      );
      if (screen === "chat")
        await expect(
          page.getByText(message.body!, { exact: true }),
        ).toBeVisible();
      else
        await expect(
          page.getByRole("textbox", { name: "Email", exact: true }),
        ).toBeVisible();
      const mountedMs = Math.round(nodePerformance.now() - started);
      const timing = await page.evaluate(() => {
        const navigation = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming;
        const resources = performance.getEntriesByType(
          "resource",
        ) as PerformanceResourceTiming[];
        return {
          firstContentfulPaintMs:
            performance.getEntriesByName("first-contentful-paint")[0]
              ?.startTime ?? null,
          responseStartMs: navigation.responseStart,
          domContentLoadedMs: navigation.domContentLoadedEventEnd,
          downloadedResourceBytes: resources.reduce(
            (sum, resource) => sum + resource.transferSize,
            0,
          ),
        };
      });
      measurements.push({ screen, mountedMs, ...timing });
    } finally {
      await context.close();
    }
  }
  const report = {
    environment:
      "Local unthrottled headless Chromium, fresh contexts/cache, 1280x900, synthetic accounts and local workerd. Not a device, network or cloud latency claim.",
    browser: browser.version(),
    measurements,
  };
  console.info(JSON.stringify(report));
  await testInfo.attach("local-startup.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
});
