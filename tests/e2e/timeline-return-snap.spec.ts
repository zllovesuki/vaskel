import type { Page } from "@playwright/test";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { deferred, fulfillHeld } from "@tests/e2e/helpers";

for (const input of ["touch", "wheel"] as const) {
  test(`returning with ${input} resumes following without jumping`, async ({
    app,
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      hasTouch: true,
      ...(input === "touch" ? { isMobile: true } : {}),
      locale: "en-US",
    });
    try {
      const room = await app.room("Return toward latest");
      for (let index = 1; index <= 60; index++) {
        await app.sendReceipt(
          index % 3 === 0 ? app.member : app.owner,
          room,
          `Message ${index}: ${"a line of wrapped chat text ".repeat(1 + (index % 5))}`,
        );
      }
      const opening = await app.snapshot(app.member, room);
      const count = String(opening.messages.length);
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
      await page.goto(`${app.origin}${roomPath(room)}`);
      const timeline = page.locator("[data-message-count]");
      const jump = page.getByRole("button", { name: "Jump to latest" });
      await expect(timeline).toHaveAttribute("data-message-count", count);
      await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
      await expect
        .poll(async () => (await app.snapshot(app.member, room)).readSequence)
        .toBe(opening.messages.at(-1)!.createdSequence);
      const box = (await timeline.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const cdp = input === "touch" ? await context.newCDPSession(page) : null;
      await page.mouse.move(x, y);
      const move = async (delta: number) => {
        if (cdp) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y, id: 1 }],
          });
          for (let step = 1; step <= 12; step++) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y - (delta * step) / 12, id: 1 }],
            });
            await page.waitForTimeout(25);
          }
          await page.waitForTimeout(100);
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        } else {
          await page.mouse.wheel(0, delta);
        }
        await page.waitForTimeout(180);
      };
      await move(-300);
      await move(-300);
      expect(await bottomGap(page)).toBeGreaterThan(300);
      await expect(jump).toBeVisible();
      for (let step = 0; step < 12; step++) {
        const gap = await bottomGap(page);
        if (gap < 100) break;
        await move(gap > 180 ? Math.min(240, gap - 150) : cdp ? 45 : 30);
      }
      // Crossing the existing follow threshold changes the mode, but must
      // leave the remaining distance for native scrolling to cover.
      await expect(jump).toHaveCount(0);
      expect(await bottomGap(page)).toBeGreaterThan(30);
      expect(await bottomGap(page)).toBeLessThan(100);

      await move(-300);
      await expect(jump).toBeVisible();
      const heldGap = await bottomGap(page);
      const captured = deferred();
      const release = deferred();
      const snapshotRoute = `**${apiPath(room)}/snapshot`;
      await page.route(snapshotRoute, async (route) => {
        const response = await route.fetch();
        captured.resolve();
        await release.promise;
        await fulfillHeld(route, response);
      });
      try {
        await jump.click();
        await captured.promise;
        await page.waitForTimeout(250);
        expect(await bottomGap(page)).toBeCloseTo(heldGap, 0);
        release.resolve();
        await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
      } finally {
        release.resolve();
      }
      // The snapshot has identical rows. Repeated explicit Latest requests
      // must still align the end, independently of changes to message data.
      await expect(timeline).toHaveAttribute("data-message-count", count);
      await move(-300);
      await expect(jump).toBeVisible();
      await jump.click();
      await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);

      const body = `A new message while following: ${"wrapped text ".repeat(20)}`;
      await app.sendReceipt(app.owner, room, body);
      await expect(page.getByText(body, { exact: true })).toBeVisible();
      await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 412, height: 715 });
      await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
}

function bottomGap(page: Page) {
  return page
    .locator("[data-message-count]")
    .evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    );
}
