import { mentionTokens } from "@vaskel/contracts/message-text";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { InviteRegistrationResponseSchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { test, expect, password, roomPath } from "@tests/e2e/fixtures";

async function edit(page: Page, row: Locator) {
  await row.hover();
  await row.getByRole("button", { name: "More", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  return row.getByLabel("Edit message", { exact: true });
}

async function select(field: Locator, start: number, end = start) {
  await field.focus();
  await field.evaluate(
    (element: HTMLTextAreaElement, range) =>
      element.setSelectionRange(range.start, range.end),
    { start, end },
  );
}

test("composer and editor keep readable names and the selected identities through native edits", async ({
  app,
  page,
}) => {
  // A second real member with the same name exercises identities that text
  // matching alone cannot preserve. The fixture's existing accounts keep names.
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
    throw new Error("Mention fixture invitation failed");
  const email = `mention-${randomUUID()}@browser.invalid`;
  const registration = InviteRegistrationResponseSchema.parse(
    (
      await app.request(null, "/api/invites/register", {
        token: invitation.token,
        registrationId: randomUUID(),
        email,
        displayName: "Browser Member",
        password,
      })
    ).result,
  );
  expect(registration).toMatchObject({ status: "registered" });
  await app.verify(email);
  const other = await app.signIn(email);
  await app.request(other, "/api/invites/join", { token: invitation.token });
  const room = await app.room("Mention editing");
  await app.open(page, app.owner, roomPath(room));

  const composer = page
    .getByRole("region", { name: room.name, exact: true })
    .getByLabel(/^Message #/);
  const suggestions = page.getByRole("option", {
    name: "Browser Member",
    exact: true,
  });
  await composer.fill("Before @Browser");
  await expect(suggestions).toHaveCount(2);
  await suggestions.nth(0).click();
  await composer.pressSequentially("@Browser");
  await expect(suggestions).toHaveCount(2);
  await suggestions.nth(1).click();
  await composer.pressSequentially("after");
  const readable = "Before @Browser Member @Browser Member after";
  await expect(composer).toHaveValue(readable);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => (await app.snapshot(app.owner, room)).messages.length)
    .toBe(1);
  const original = (await app.snapshot(app.owner, room)).messages[0]!;
  const identities = mentionTokens(original.body!).map(
    (mention) => mention.userId,
  );
  expect(new Set(identities)).toEqual(
    new Set([app.member.profile.userId, other.profile.userId]),
  );
  const first = identities[0]!;
  const second = identities[1]!;
  const row = page.locator("article.message-row");
  const saved = async (body: string, mentions: string[]) => {
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => {
        const message = (await app.snapshot(app.owner, room)).messages[0];
        return { body: message?.body, mentions: message?.mentions.toSorted() };
      })
      .toEqual({ body, mentions: mentions.toSorted() });
    await expect(row.getByLabel("Edit message", { exact: true })).toHaveCount(
      0,
    );
  };

  let field = await edit(page, row);
  await expect(field).toHaveValue(readable);
  await select(field, 0);
  await field.pressSequentially("Updated ");
  await saved(
    `Updated Before [](/mentions/${first}) [](/mentions/${second}) after`,
    [first, second],
  );

  field = await edit(page, row);
  await expect(field).toHaveValue(`Updated ${readable}`);
  const start = "Updated Before ".length;
  await select(field, start, start + "@Browser Member ".length);
  await field.press("Backspace");
  await expect(field).toHaveValue("Updated Before @Browser Member after");
  await saved(`Updated Before [](/mentions/${second}) after`, [second]);

  // Replacing the remaining name through completion chooses a different
  // account even though the rendered name and surrounding text stay the same.
  field = await edit(page, row);
  await select(field, start, start + "@Browser Member".length);
  await field.pressSequentially("@Browser");
  await expect(suggestions).toHaveCount(2);
  await suggestions.nth(0).click();
  await saved(`Updated Before [](/mentions/${first}) after`, [first]);

  // Native insertion of code delimiters makes the readable text literal and
  // removes the authoritative mention, without exposing the old wire token.
  field = await edit(page, row);
  await select(field, start);
  await field.pressSequentially("`");
  await select(field, start + 1 + "@Browser Member".length);
  await field.pressSequentially("`");
  await saved("Updated Before `@Browser Member` after", []);
});

test("Markdown spoilers conceal nested links until a keyboard reveal", async ({
  app,
  page,
}) => {
  const room = await app.room("Markdown spoilers");
  await app.send(
    app.owner,
    room,
    "Visible text ||secret [safe link](https://example.com)||\nnext line",
  );
  await app.send(
    app.owner,
    room,
    "[||covered destination||](https://example.com)",
  );
  await app.send(app.owner, room, "||outer ||inner|| text||");
  await app.open(page, app.member, roomPath(room));
  const row = page
    .locator("article.message-row")
    .filter({ hasText: "Visible text" });
  const reveal = row.getByRole("button", { name: "Show hidden text" });
  const link = row.getByRole("link", {
    name: "safe link",
    includeHidden: true,
  });
  await expect(link).toBeHidden();
  await expect(row.locator("button a")).toHaveCount(0);
  await reveal.focus();
  await reveal.press("Enter");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(reveal).toHaveCount(0);
  await expect(row).toContainText("next line");
  const spoilerLabel = page
    .locator("article.message-row")
    .filter({ hasText: "covered destination" });
  await expect(spoilerLabel.locator("a")).toHaveCount(0);
  await spoilerLabel.getByRole("button", { name: "Show hidden text" }).click();
  await expect(
    spoilerLabel.getByText("covered destination", { exact: true }),
  ).toBeVisible();
  const nested = page
    .locator("article.message-row")
    .filter({ hasText: "outer" });
  const nestedReveal = nested.getByRole("button", { name: "Show hidden text" });
  await expect(nestedReveal).toHaveCount(1);
  await nestedReveal.click();
  await expect(nestedReveal).toHaveCount(1);
  await nestedReveal.focus();
  await nestedReveal.press("Space");
  await expect(nestedReveal).toHaveCount(0);
  await expect(nested.getByText("inner", { exact: true })).toBeVisible();
});

test("script-shaped display names stay literal through picking and editing", async ({
  app,
  page,
}) => {
  const name = "<script>alert('rick roll')</script>";
  await app.request(app.member, "/api/identity/profile", { name });
  const room = await app.room("Literal names");
  await app.open(page, app.owner, roomPath(room));
  const composer = page
    .getByRole("region", { name: room.name, exact: true })
    .getByLabel(/^Message #/);
  await composer.fill("@<script>");
  await page.getByRole("option", { name, exact: true }).click();
  await expect(composer).toHaveValue(`@${name} `);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const row = page.locator("article.message-row");
  await expect(row.locator(".mention")).toHaveText(`@${name}`);
  await expect(row.locator("script")).toHaveCount(0);
  const field = await edit(page, row);
  await expect(field).toHaveValue(`@${name}`);
  await select(field, 0);
  await field.pressSequentially("Hello ");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () => (await app.snapshot(app.owner, room)).messages[0]?.mentions,
    )
    .toEqual([app.member.profile.userId]);
  await expect(row.locator(".mention")).toHaveText(`@${name}`);
  await expect(row.locator("script")).toHaveCount(0);
});
