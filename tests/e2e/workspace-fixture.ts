import type { Browser, Page } from "@playwright/test";
import type { Account, BrowserApplication } from "@tests/e2e/fixtures";
import { deferred, fulfillHeld } from "@tests/e2e/helpers";

/** A fresh context carrying the fixture cookie: a cold deep link, not a warm reload. */
export async function coldContext(
  browser: Browser,
  app: BrowserApplication,
  account: Account,
  viewport: { width: number; height: number },
) {
  const touch = viewport.width < 640;
  const context = await browser.newContext({
    viewport,
    locale: "en-US",
    isMobile: touch,
    hasTouch: touch,
  });
  await context.addCookies(
    account.cookie.split("; ").map((cookie) => {
      const equals = cookie.indexOf("=");
      return {
        name: cookie.slice(0, equals),
        value: cookie.slice(equals + 1),
        url: app.origin,
      };
    }),
  );
  return context;
}

/** Holds matching requests until released, then answers them from the real server. */
export async function hold(page: Page, pattern: string) {
  const gate = deferred();
  const reached = deferred();
  await page.route(pattern, async (route) => {
    reached.resolve();
    await gate.promise;
    await fulfillHeld(route, await route.fetch());
  });
  return { release: gate.resolve, reached: reached.promise };
}

export const announcement = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Opening your conversations…" });
