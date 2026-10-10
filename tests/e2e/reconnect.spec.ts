import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { hold } from "./workspace-fixture";

const reconnecting = "Reconnecting and checking your conversations…";
const connectionLost = "Connection lost. You can still read open messages.";

test("reconnect preserves the conversation, draft and navigation while waiting for a fresh snapshot before Send", async ({
  app,
  page,
  context,
}) => {
  const room = await app.room("Fresh snapshot");
  const message = await app.send(app.owner, room, "Still here offline");
  await app.open(page, app.owner, roomPath(room));
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("Keep this authored draft");
  await context.setOffline(true);
  await expect(page.getByText(connectionLost)).toBeVisible();
  const circleActions = page.getByRole("button", {
    name: "Circle actions",
    exact: true,
  });
  const circleSettings = page.getByRole("menuitem", {
    name: "Circle settings",
    exact: true,
  });
  await circleActions.click();
  await expect(circleSettings).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep this authored draft");
  await expect(page.locator("[data-skeleton]")).toHaveCount(0);
  const snapshot = await hold(page, `**${apiPath(room)}/snapshot*`);
  await context.setOffline(false);
  await snapshot.reached;
  await expect(composer).toHaveValue("Keep this authored draft");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await expect(page.locator('[data-skeleton="header"]')).toHaveCount(0);
  snapshot.release();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(connectionLost)).toBeHidden();
  await expect(page.getByText(reconnecting)).toBeHidden();
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep this authored draft");
  await expect(
    page.getByRole("link", { name: `${room.name} Draft`, exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-skeleton]")).toHaveCount(0);
  await circleActions.click();
  await expect(circleSettings).toBeEnabled();
});

test("a failed reconnect snapshot keeps messages and the draft with local Retry", async ({
  app,
  page,
  context,
}) => {
  const room = await app.room("Local snapshot recovery");
  const message = await app.send(app.owner, room, "Retained during recovery");
  await app.open(page, app.member, roomPath(room));
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("Keep this draft through a failed snapshot");
  await context.setOffline(true);
  await expect(page.getByText(connectionLost)).toBeVisible();
  let failing = true;
  await page.route(`**${apiPath(room)}/snapshot*`, (route) =>
    failing ? route.abort("failed") : route.continue(),
  );
  await context.setOffline(false);
  const retry = page
    .locator("main")
    .getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByText(connectionLost)).toBeHidden();
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(
    "Keep this draft through a failed snapshot",
  );
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  failing = false;
  await retry.click();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await expect(composer).toHaveValue(
    "Keep this draft through a failed snapshot",
  );
});
