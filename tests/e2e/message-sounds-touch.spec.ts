import { test, expect } from "@tests/e2e/fixtures";
import {
  chimes,
  countChimes,
  inboxFrames,
  settingsRead,
} from "@tests/e2e/helpers";

// Trace snapshots evaluate script in the page, which grants user activation.
test.use({ trace: "off" });

test("one tap on a touch screen lets message sounds play", async ({
  app,
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    hasTouch: true,
    locale: "en-US",
  });
  try {
    await countChimes(context);
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
    const frames = inboxFrames(page);
    // Until the tap, waits use the network only; evaluating script would grant
    // activation too.
    const loaded = settingsRead(page);
    await page.goto(`${app.origin}/settings/notifications`);
    await loaded;
    await expect
      .poll(() => frames.some((frame) => frame.type === "ready"))
      .toBe(true);
    // A finger rests before lifting, and touch grants activation only on lift.
    const touch = await context.newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 4, y: 4 }],
    });
    await page.waitForTimeout(120);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await app.sendReceipt(app.owner, app.dm, "Tapped once");
    await expect.poll(() => chimes(page)).toBe(1);
  } finally {
    await context.close();
  }
});
