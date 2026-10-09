import type { Locator, Page } from "@playwright/test";
import { expect } from "@tests/e2e/fixtures";

/** First installation does not claim the open document. */
export async function controlShell(page: Page) {
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    )
    .toBe(`${new URL(page.url()).origin}/sw.js`);
}

/**
 * Install a native candidate in the existing registration without changing dist.
 * The isolated A/B fixture owns evidence that changed build bytes load; these
 * cases exercise the real workspace and recovery through the prompt helper.
 */
export async function offerShellUpdate(page: Page) {
  await page.evaluate(async () => {
    document.body.dataset.shellDocument = "before-update";
    await navigator.serviceWorker.register("/sw.js?candidate=workspace", {
      scope: "/",
      updateViaCache: "none",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.waiting?.state,
      ),
    )
    .toBe("installed");
}

export async function acceptShellUpdate(
  page: Page,
  action: Locator = page.getByRole("button", {
    name: "Update now",
    exact: true,
  }),
) {
  const url = page.url();
  await expect(action).toBeEnabled();
  await Promise.all([page.waitForEvent("domcontentloaded"), action.click()]);
  await expect(page).toHaveURL(url);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-shell-document",
    "before-update",
  );
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
  ).toBe(`${new URL(url).origin}/sw.js?candidate=workspace`);
}
