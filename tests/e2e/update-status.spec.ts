import { test, expect, roomPath } from "@tests/e2e/fixtures";
import { controlShell, offerShellUpdate } from "@tests/e2e/shell-update";

test("the desktop update notice preserves focus, yields to connection status and accepts the keyboard action", async ({
  app,
  page,
  context,
}) => {
  await app.open(page, app.member, roomPath(app.circle));
  const action = page.getByRole("button", {
    name: "Update now",
    exact: true,
  });
  await expect(action).toHaveCount(0);
  await controlShell(page);
  await expect(action).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.focus();
  await offerShellUpdate(page);
  const notice = page.getByRole("status").filter({
    hasText: "A new version is ready. Updating will reload this page.",
  });
  await expect(notice).toBeVisible();
  await expect(action).toHaveCount(1);
  await expect(composer).toBeFocused();
  const strip = await notice.boundingBox();
  const header = await page.locator("main header").first().boundingBox();
  expect(strip).not.toBeNull();
  expect(header).not.toBeNull();
  expect(strip!.y + strip!.height).toBeCloseTo(header!.y, 0);
  await context.setOffline(true);
  await expect(
    page.getByText("Connection lost. You can still read open messages.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(action).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-shell-document",
    "before-update",
  );
  await context.setOffline(false);
  await expect(notice).toBeVisible();
  // Reach the real action through the normal tab order, without assigning focus
  // directly to it. Accepting with Enter takes the helper's native reload path.
  await composer.focus();
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press("Tab");
    if (await action.evaluate((button) => button === document.activeElement))
      break;
  }
  await expect(action).toBeFocused();
  const url = page.url();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.keyboard.press("Enter"),
  ]);
  await expect(page).toHaveURL(url);
  await expect(composer).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-shell-document",
    "before-update",
  );
});

test("the translated phone update notice wraps within the page pane and Home temporarily hides it", async ({
  app,
  page,
}) => {
  await app.open(page, app.member, roomPath(app.circle));
  await app.request(app.member, "/api/account/preferences", { language: "ja" });
  await page.setViewportSize({ width: 320, height: 740 });
  await controlShell(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await offerShellUpdate(page);
  const notice = page.getByRole("status").filter({
    hasText:
      "新しいバージョンが利用できます。更新すると、このページが再読み込みされます。",
  });
  const action = page.getByRole("button", {
    name: "今すぐ更新",
    exact: true,
  });
  await expect(action).toBeVisible();
  const layout = await notice.evaluate((element) => {
    const text = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const strip = element.getBoundingClientRect();
    const copy = element.querySelector("p")!.getBoundingClientRect();
    const button = element.querySelector("button")!.getBoundingClientRect();
    const message = text(element.querySelector("p")!);
    const label = text(element.querySelector("button")!);
    return {
      fits:
        strip.left >= 0 &&
        strip.right <= innerWidth &&
        button.right <= strip.right,
      wraps: button.top >= copy.bottom,
      // A wrapped action keeps the strip as even as one beside the message:
      // within its 1 px border and text rounding.
      even:
        Math.abs(message.top - strip.top - (strip.bottom - label.bottom)) <= 2,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(layout).toEqual({
    fits: true,
    wraps: true,
    even: true,
    overflow: false,
  });
  await page
    .getByRole("button", { name: "会話一覧を開く", exact: true })
    .click();
  await expect(notice).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible();
  await expect(action).toBeEnabled();
  await expect(page.locator("body")).toHaveAttribute(
    "data-shell-document",
    "before-update",
  );
});
