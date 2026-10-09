import { test, expect, password, roomPath } from "@tests/e2e/fixtures";
import { fitsPhone } from "@tests/e2e/entry-fixture";

test("requesting password recovery keeps the email form and an enumeration-safe confirmation", async ({
  app,
  page,
}) => {
  await page.goto(`${app.origin}/forgot-password`);
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(app.member.email);
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        "If this email belongs to an account, a reset link is on its way. Check your inbox.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Email", exact: true }),
  ).toHaveValue(app.member.email);
  await expect(
    page.getByRole("link", { name: "Back to sign in", exact: true }),
  ).toBeVisible();
});

test("a signed-in password reset retires the session before signing in with the replacement password", async ({
  app,
  page,
}) => {
  await app.open(page, app.member, roomPath(app.circle));
  await app.request(null, "/api/identity/request-password-reset", {
    email: app.member.email,
  });
  const token = await app.mailedToken("reset-password", app.member.email);
  await page.goto(`${app.origin}/reset-password?token=${token}`);
  const replacement = `${password} renewed`;
  await page.getByLabel(/^Password/).fill(replacement);
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/sign-in");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(app.member.email);
  await page.getByLabel(/^Password/).fill(replacement);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Account options", exact: true }),
  ).toBeVisible();
});

test("password reset finishes with one sign-in action on a phone", async ({
  app,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  // A changed password ends with one way to sign in.
  await app.request(null, "/api/identity/request-password-reset", {
    email: app.member.email,
  });
  await page.goto(
    `${app.origin}/reset-password?token=${await app.mailedToken("reset-password", app.member.email)}`,
  );
  await page.locator("input[type=password]").fill(`${password} renewed`);
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Password changed", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveCount(
    0,
  );
  await expect(signIn).toBeVisible();
  await fitsPhone(page);
});
