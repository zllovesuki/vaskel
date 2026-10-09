import { deferred } from "@tests/shared/deferred";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";

test("inline edits survive virtualized unmounts, navigation cancellation and a lost accepted response", async ({
  app,
  page,
}) => {
  const room = await app.room("Editing lifetime");
  for (let index = 0; index < 50; index++)
    await app.sendReceipt(
      app.member,
      room,
      `History ${index}\nSecond line\nThird line`,
    );
  const message = await app.send(app.member, room, "Edit this message");
  await app.open(page, app.member, roomPath(room));
  const row = page.locator(
    `[data-timeline-sequence="${message.createdSequence}"]`,
  );
  const scroll = page.locator("[data-message-count]");
  await row.hover();
  await row.getByRole("button", { name: "More", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const editor = row.getByLabel("Edit message", { exact: true });
  await editor.fill("保留する編集\nKeep this draft");
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(row).toHaveCount(0);
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(editor).toHaveValue("保留する編集\nKeep this draft");
  await page.getByRole("link", { name: "vaskel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(editor).toHaveValue("保留する編集\nKeep this draft");

  const { promise: held, resolve: release } = deferred();
  const { promise: accepted, resolve: committed } = deferred();
  const commands: string[] = [];
  await page.route(`**${apiPath(room)}/edit`, async (route) => {
    commands.push(
      (route.request().postDataJSON() as { commandId: string }).commandId,
    );
    if (commands.length > 1) return route.continue();
    await route.fetch();
    committed();
    await held;
    await route.abort("failed");
  });
  try {
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await accepted;
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(row).toHaveCount(0);
    release();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const retry = row.getByRole("button", { name: "Retry save", exact: true });
    await expect(retry).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Reconnect", exact: true }),
    ).toHaveCount(0);
    await retry.click();
    await expect(editor).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    const current = (await app.snapshot(app.member, room)).messages.find(
      (entry) => entry.id === message.id,
    );
    expect(current).toMatchObject({
      body: "保留する編集\nKeep this draft",
      version: 2,
    });
  } finally {
    release();
  }
});
