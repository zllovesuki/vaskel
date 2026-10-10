import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { deferred, fulfillHeld } from "@tests/e2e/helpers";

test("search jumps center the selected row after variable-height messages settle", async ({
  app,
  page,
}) => {
  const room = await app.room("Search positioning");
  const sequences: number[] = [];
  for (let index = 1; index <= 90; index++) {
    const receipt = await app.sendReceipt(
      app.owner,
      room,
      `PositionNeedle${String(index).padStart(3, "0")}\n\n${"Some ordinary chat text with a varying length. ".repeat(1 + (index % 7) * 9)}`,
    );
    sequences.push(receipt.sequence);
  }
  await app.open(page, app.member, "/search");
  // The early around-window includes the room intro; the later one has paging.
  for (const target of [15, 50]) {
    await page.goto(
      `${app.origin}/search?q=PositionNeedle${String(target).padStart(3, "0")}`,
    );
    await page
      .getByRole("link", { name: "Open at message", exact: true })
      .click();
    const row = page.locator(
      `[data-timeline-sequence="${sequences[target - 1]}"]`,
    );
    await expect(row.locator("article")).toBeFocused();
    const centerError = () =>
      row.evaluate((element) => {
        const viewport = element.closest("[data-message-count]")!;
        const outer = viewport.getBoundingClientRect();
        const inner = element.getBoundingClientRect();
        return Math.abs(
          (inner.top + inner.bottom - outer.top - outer.bottom) / 2,
        );
      });
    await expect.poll(centerError).toBeLessThan(2);
    // Focus and mounting alone also pass for rows outside the visible viewport.
    await expect(row).toBeInViewport({ ratio: 1 });
    await expect(row.locator("article")).not.toHaveAttribute(
      "data-jump-target",
    );
    expect(await centerError()).toBeLessThan(2);
  }
});

for (const target of [1, 65]) {
  test(`a held around request at message ${target} never reads the resident latest tail`, async ({
    app,
    page,
  }) => {
    const room = await app.room(`Around ${target}`);
    const messages = [];
    for (let index = 1; index <= 70; index++) {
      const body = `Around ${target} message ${index}: variable height ${"wrapped words ".repeat(index % 5)}`;
      const receipt = await app.sendReceipt(app.owner, room, body);
      messages.push({ body, createdSequence: receipt.sequence });
    }
    const chosen = messages[target - 1]!;
    const captured = deferred();
    const release = deferred();
    await page.route(`**${apiPath(room)}/around`, async (route) => {
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await fulfillHeld(route, response);
    });
    try {
      await app.open(
        page,
        app.member,
        `${roomPath(room)}?at=${chosen.createdSequence}`,
      );
      await captured.promise;
      // Keep the request pending beyond the visible-read debounce.
      await page.waitForTimeout(900);
      expect((await app.snapshot(app.member, room)).readSequence).toBe(0);
      release.resolve();
      await expect(page.getByText(chosen.body!, { exact: true })).toBeVisible();
      await page.waitForTimeout(700);
      expect((await app.snapshot(app.member, room)).readSequence).toBe(0);
    } finally {
      release.resolve();
    }
  });
}

for (const target of [5, 45]) {
  test(`conversation search opens and reopens message ${target} without losing keyboard navigation`, async ({
    app,
    page,
  }) => {
    const room = await app.room("Conversation search");
    const messages: string[] = [];
    for (let index = 1; index <= 55; index++) {
      const body = `${index === 5 || index === 45 ? "RefactorNeedle" : "Conversation"} message ${index}`;
      await app.sendReceipt(app.owner, room, body);
      messages.push(body);
    }
    await app.open(page, app.member, roomPath(room));
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Find a phrase" })
      .fill("RefactorNeedle");
    await page
      .getByRole("button", { name: "Search messages", exact: true })
      .click();

    const results = page.getByRole("complementary", { name: "Search results" });
    await expect(results.getByRole("article")).toHaveCount(2);
    const selected = results
      .getByRole("article")
      .filter({ hasText: messages[target - 1]! });
    await selected.getByRole("button", { name: "Open at message" }).click();
    await expect(results.getByRole("article")).toHaveCount(0);
    const row = page
      .locator("article.message-row")
      .filter({ hasText: messages[target - 1]! });
    await expect(row).toBeFocused();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("at"))
      .toBeNull();
    expect(new URL(page.url()).searchParams.get("q")).toBe("RefactorNeedle");

    await row.press("ArrowDown");
    const next = page
      .locator("article.message-row")
      .filter({ hasText: messages[target]! });
    await expect(next).toBeFocused();
    await next.press("ArrowUp");
    await expect(row).toBeFocused();

    await results.getByRole("button", { name: "Show results" }).click();
    await expect(results.getByRole("article")).toHaveCount(2);
    // Reopening the same row is a new navigation even while its first highlight
    // is still active. Neither the collapsed results nor measurement can own it.
    await selected.getByRole("button", { name: "Open at message" }).click();
    await expect(row).toBeFocused();
    await results.getByRole("button", { name: "Close search" }).click();
    await expect(results).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBeNull();
    await expect(page.getByLabel(/^Message /)).toBeEditable();
  });
}
