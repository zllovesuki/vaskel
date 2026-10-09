import { randomUUID } from "node:crypto";
import { InviteRegistrationSchema } from "@vaskel/contracts/directory";
import { test, expect, password } from "@tests/e2e/fixtures";
import { invitation, fitsPhone } from "@tests/e2e/entry-fixture";
import { hold } from "./workspace-fixture";

test("invitation credentials and registration identity survive toggling and a failed submission", async ({
  app,
  page,
}) => {
  const email = `toggle-${randomUUID()}@browser.invalid`;
  await page.goto(`${app.origin}/invite?token=${await invitation(app)}`);
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Retained member");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  const submitted: unknown[] = [];
  await page.route("**/api/invites/register", async (route) => {
    submitted.push(
      InviteRegistrationSchema.parse(route.request().postDataJSON()),
    );
    if (submitted.length === 1) await route.abort("failed");
    else await route.continue();
  });
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", {
      name: "Already have an account? Sign in",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sign in to join", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Email", exact: true }),
  ).toHaveValue(email);
  await expect(page.getByLabel(/^Password/)).toHaveValue(password);
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Retained member",
  );
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true }),
  ).toBeFocused();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  await expect(page.getByLabel(/^Password/)).toHaveValue("");
});

test("an invitation continues from its verification link through sign-in to the circle", async ({
  app,
  page,
}) => {
  const email = `entry-${randomUUID()}@browser.invalid`;
  await page.goto(`${app.origin}/invite?token=${await invitation(app)}`);
  await expect(
    page.getByText("You’ve been invited to Browser Circle.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Display name", { exact: true }).fill("Entry Member");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.locator("input[type=password]").fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  // Registered: the address and the next step, with sign-in kept here.
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("Check your email");
  await expect(title).toBeFocused();
  await expect(
    page.getByText(
      `A verification link is on its way to ${email}. After you verify, sign in here to join Browser Circle.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Email", exact: true }),
  ).toHaveValue(email);
  await expect(page.getByLabel(/^Password/)).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Create an account" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Forgot password?" }),
  ).toHaveCount(0);

  // Signing in before verifying keeps exactly one way to another link.
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Check your email to verify your account before signing in.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resend verification email" }),
  ).toHaveCount(1);

  // The emailed link opens in another tab of the same browser.
  const tab = await page.context().newPage();
  await tab.goto(
    `${app.origin}/verify-email?token=${await app.mailedToken("verify-email", email)}`,
  );
  await expect(
    tab.getByRole("heading", { name: "Verify your email", exact: true }),
  ).toBeVisible();
  await expect(tab.getByRole("link", { name: "Back to sign in" })).toHaveCount(
    0,
  );
  await tab.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(
    tab.getByRole("heading", { name: "Email verified", exact: true }),
  ).toBeFocused();
  await expect(tab.getByRole("button", { name: "Verify email" })).toHaveCount(
    0,
  );
  await expect(tab.getByRole("link", { name: "Back to sign in" })).toHaveCount(
    0,
  );
  await tab.getByRole("link", { name: "Sign in", exact: true }).click();

  // Signing in there continues to the invitation this browser registered.
  await tab.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await tab.getByLabel(/^Password/).fill(password);
  await tab.getByRole("button", { name: "Sign in", exact: true }).click();
  const join = tab.getByRole("button", {
    name: "Join Browser Circle",
    exact: true,
  });
  await expect(join).toBeVisible();
  expect(new URL(tab.url()).pathname).toBe("/invite");
  const discovery = await hold(tab, "**/api/directory*");
  try {
    await join.click();
    await discovery.reached;
    await tab.waitForURL(new RegExp(`/servers/${app.circle.owner.id}`));
    // Joining opens the authorized circle while discovery is still loading.
    await expect(tab.getByRole("textbox", { name: /^Message / })).toBeVisible();
  } finally {
    discovery.release();
  }

  // Joined, the invitation is forgotten and sign-in no longer leads to it.
  expect(
    await tab.evaluate(() => localStorage.getItem("vaskel.invitation")),
  ).toBeNull();
  await tab.goto(`${app.origin}/sign-in`);
  await expect(
    tab.getByRole("button", { name: "Account options", exact: true }),
  ).toBeVisible();
  expect(new URL(tab.url()).pathname).not.toBe("/invite");
});

test("invited registration keeps its next step readable on a phone", async ({
  app,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.origin}/invite?token=${await invitation(app)}`);
  await page.getByLabel("Display name", { exact: true }).fill("Entry Member");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`entry.member.with.a.long.address.${randomUUID()}@browser.invalid`);
  await page.locator("input[type=password]").fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true }),
  ).toBeVisible();
  await fitsPhone(page);
});
