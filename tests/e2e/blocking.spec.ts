import { apiErrorResponse } from "@tests/e2e/helpers";
import { randomUUID } from "node:crypto";
import { BlockOutcomeSchema } from "@vaskel/contracts/blocking";
import { InviteRegistrationResponseSchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import {
  test,
  expect,
  password,
  roomPath,
  type Account,
  type BrowserApplication,
} from "@tests/e2e/fixtures";

const longName = "Bartholomew Fitzgerald-Montgomery the Third";

/** A circle member with this display name, signed in through the API. */
async function member(app: BrowserApplication, displayName: string) {
  const invitation = AdministrationOutcomeSchema.parse(
    (
      await app.request(
        app.owner,
        `/api/servers/${app.circle.owner.id}/invites`,
        { expiresAt: Date.now() + 3_600_000, maxUses: 1 },
      )
    ).result,
  );
  if (invitation.kind !== "invite_created")
    throw new Error("Blocking fixture invitation failed");
  const email = `blocking-${randomUUID()}@browser.invalid`;
  const registration = InviteRegistrationResponseSchema.parse(
    (
      await app.request(null, "/api/invites/register", {
        token: invitation.token,
        registrationId: randomUUID(),
        email,
        displayName,
        password,
      })
    ).result,
  );
  expect(registration).toMatchObject({ status: "registered" });
  await app.verify(email);
  const account = await app.signIn(email);
  await app.request(account, "/api/invites/join", { token: invitation.token });
  return account;
}

async function blockStatus(app: BrowserApplication, target: Account) {
  const outcome = BlockOutcomeSchema.parse(
    (
      await app.request(
        app.owner,
        `/api/account/blocks/${target.profile.userId}`,
      )
    ).result,
  );
  if (outcome.kind !== "block_status")
    throw new Error("Blocking fixture status failed");
  return outcome.status;
}

async function block(app: BrowserApplication, target: Account) {
  const { revision } = await blockStatus(app, target);
  await app.request(
    app.owner,
    `/api/account/blocks/${target.profile.userId}`,
    {
      commandId: randomUUID(),
      issuedAt: Date.now(),
      blocked: true,
      expectedRevision: revision,
    },
    "PUT",
  );
}

test("blocked people name everyone and confirm unblocking in place", async ({
  app,
  page,
}) => {
  test.setTimeout(120_000);
  const cass = await member(app, "Cass");
  const tangyuan = await member(app, "汤圆");
  const long = await member(app, longName);
  for (const person of [app.member, cass, tangyuan, long])
    await block(app, person);
  await app.open(page, app.owner, "/settings/blocked");
  await expect(
    page.getByRole("heading", { name: "Blocked people", level: 1 }),
  ).toBeVisible();
  const list = page.getByRole("list", { name: "People you’ve blocked" });
  for (const name of ["Browser Member", "Cass", "汤圆", longName])
    await expect(list.getByText(name, { exact: true })).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(list).not.toContainText(cass.profile.userId);

  // Unblocking asks in place; cancelling returns to the row's button.
  const unblockCass = page.getByRole("button", {
    name: "Unblock Cass",
    exact: true,
  });
  await unblockCass.click();
  const question = page.getByRole("group", { name: "Unblock Cass?" });
  const confirm = question.getByRole("button", {
    name: "Unblock",
    exact: true,
  });
  await expect(confirm).toBeFocused();
  // The row's button steps aside, so the question holds the only Unblock.
  await expect(unblockCass).toBeHidden();
  await expect(question).toContainText(
    "They’ll be able to send you direct messages and files again.",
  );
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(unblockCass).toBeFocused();
  expect((await blockStatus(app, cass)).blocked).toBe(true);

  // Confirmed, the row leaves the list and focus stays with the list.
  await unblockCass.click();
  await confirm.click();
  await expect(unblockCass).toHaveCount(0);
  await expect(list).toBeFocused();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  expect((await blockStatus(app, cass)).blocked).toBe(false);
  expect((await blockStatus(app, tangyuan)).blocked).toBe(true);

  // Names that cannot be read never appear as bare IDs without the note.
  await page.route("**/api/people?**", (route) =>
    route.fulfill(apiErrorResponse("UNAVAILABLE")),
  );
  await page.reload();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  // While names are retried, rows wait unnamed and cannot be unblocked.
  const unnamed = list.getByRole("button", { name: "Unblock", exact: true });
  await expect(unnamed).toHaveCount(3);
  for (const button of await unnamed.all()) await expect(button).toBeDisabled();
  await expect(list).not.toContainText(tangyuan.profile.userId.slice(0, 8));
  await expect(
    page.getByText(
      "Some names couldn’t be loaded. Account IDs are shown instead.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    list.getByText(tangyuan.profile.userId.slice(0, 8), { exact: true }),
  ).toBeVisible();
  await expect(list).not.toContainText(tangyuan.profile.userId);
  await expect(
    page.getByRole("button", {
      name: `Unblock ${tangyuan.profile.userId.slice(0, 8)}`,
      exact: true,
    }),
  ).toBeEnabled();
  await page.unroute("**/api/people?**");

  // The direct message header shares the command and stays one click.
  await page.goto(`${app.origin}${roomPath(app.dm)}`);
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page
    .getByRole("button", { name: "Unblock Browser Member", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Block Browser Member", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unblock Browser Member", exact: true }),
  ).toBeVisible();
  expect((await blockStatus(app, app.member)).blocked).toBe(true);
});

test("blocked people fit a phone and explain an empty list", async ({
  app,
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await block(app, await member(app, longName));
  await app.open(page, app.owner, "/settings/blocked");
  await page.setViewportSize({ width: 390, height: 844 });
  const title = page.getByRole("heading", { name: "Blocked people", level: 1 });
  await expect(title).toBeVisible();
  // The title follows the header's controls instead of the far edge.
  expect((await title.boundingBox())!.x).toBeLessThan(160);
  const name = page.getByText(longName, { exact: true });
  const unblock = page.getByRole("button", {
    name: `Unblock ${longName}`,
    exact: true,
  });
  const nameBox = (await name.boundingBox())!;
  const unblockBox = (await unblock.boundingBox())!;
  // A long name wraps beside its button rather than pushing it down.
  expect(unblockBox.y).toBeLessThan(nameBox.y + nameBox.height);
  expect(unblockBox.x).toBeGreaterThan(nameBox.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );

  // Someone who hasn't blocked anyone learns where blocking happens.
  const context = await browser.newContext();
  const other = await context.newPage();
  await app.open(other, app.member, "/settings/blocked");
  await other.setViewportSize({ width: 390, height: 844 });
  await expect(
    other.getByText("You haven’t blocked anyone.", { exact: true }),
  ).toBeVisible();
  await expect(
    other.getByText(
      "To block someone, use Options in your direct messages with them, or next to their name when you start a conversation.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await other.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await context.close();
});
