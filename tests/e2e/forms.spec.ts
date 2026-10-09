import { apiErrorResponse } from "@tests/e2e/helpers";
import { test, expect, password, roomPath } from "@tests/e2e/fixtures";

test("account forms preserve rejected values, validate matching passwords, and reset after success", async ({
  app,
  page,
}) => {
  await app.open(page, app.owner, "/settings/account");
  const sessions = page.getByRole("list", {
    name: "Where you’re signed in",
    exact: true,
  });
  await expect(sessions.getByText(/^Signed in /).first()).toBeVisible();
  await expect(sessions.getByText(/^Last used /)).toHaveCount(0);
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  const saveName = page.getByRole("button", { name: "Save name", exact: true });
  await name.fill("   ");
  await expect(saveName).toBeDisabled();
  await name.fill("  日本語の名前  ");
  await saveName.click();
  await expect(page.getByText("Name saved.", { exact: true })).toBeVisible();
  await expect(saveName).toBeDisabled();
  await name.fill("次の名前");
  await expect(page.getByText("Name saved.", { exact: true })).toHaveCount(0);
  await expect(saveName).toBeEnabled();

  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel("New password", { exact: false }).first();
  const repeat = page.getByLabel("Repeat new password", { exact: true });
  const change = page.getByRole("button", {
    name: "Change password",
    exact: true,
  });
  const newPassword = "replacement synthetic browser password";
  let submissions = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/identity/change-password")
      submissions++;
  });
  await current.fill("incorrect existing password");
  await next.fill(newPassword);
  await repeat.fill("a different replacement password");
  await change.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The two new passwords don’t match." }),
  ).toBeVisible();
  expect(submissions).toBe(0);
  await repeat.fill(newPassword);
  await change.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "That current password isn’t right." }),
  ).toBeVisible();
  await expect(next).toHaveValue(newPassword);
  await expect(repeat).toHaveValue(newPassword);
  await current.fill(password);
  await change.click();
  await expect(
    page.getByText("Password changed.", { exact: true }),
  ).toBeVisible();
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");
  await expect(repeat).toHaveValue("");
  expect(submissions).toBe(2);
});

test("signing out another browser asks in place and keeps one Sign out", async ({
  app,
  page,
}) => {
  // The fixture's own sign-in is the other browser beside this one.
  await app.open(page, app.owner, "/settings/account");
  const sessions = page.getByRole("list", {
    name: "Where you’re signed in",
    exact: true,
  });
  await expect(sessions.getByRole("listitem")).toHaveCount(2);
  const other = sessions.getByRole("button", {
    name: "Sign out Other browser",
    exact: true,
  });
  await other.click();
  const question = sessions.getByRole("group", {
    name: "Sign Other browser out of your account?",
  });
  await expect(
    question.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeFocused();
  // The row's button steps aside while the question is open.
  await expect(other).toBeHidden();
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(other).toBeFocused();
  await expect(sessions.getByRole("listitem")).toHaveCount(2);
});

test("circle creation retries the same command and starts a new one only after editing", async ({
  app,
  page,
}) => {
  await app.open(page, app.owner, roomPath(app.circle));
  await page.getByRole("button", { name: "Add a circle", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", {
    name: "Circle name",
    exact: true,
  });
  const room = dialog.getByRole("textbox", {
    name: "First room",
    exact: false,
  });
  const create = dialog.getByRole("button", {
    name: "Create circle",
    exact: true,
  });
  const attempts: Array<{
    commandId: string;
    name: string;
    firstChannelName?: string;
  }> = [];
  await page.route("**/api/servers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON() as (typeof attempts)[number]);
    if (attempts.length <= 2) {
      await route.fulfill(apiErrorResponse("CAPACITY", { kind: "capacity" }));
    } else await route.continue();
  });
  await name.fill("A retryable circle");
  await room.fill("最初の部屋");
  await create.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(create).toBeEnabled();
  await create.click();
  await expect.poll(() => attempts.length).toBe(2);
  await expect(create).toBeEnabled();
  expect(attempts[1]).toEqual(attempts[0]);
  await name.fill("A revised circle");
  await create.click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toHaveLength(3);
  expect(attempts[2]!.commandId).not.toBe(attempts[0]!.commandId);
  expect(attempts[2]!.firstChannelName).toBe("最初の部屋");
  await expect(
    page.getByRole("heading", { name: "最初の部屋", exact: true }),
  ).toBeVisible();
});
