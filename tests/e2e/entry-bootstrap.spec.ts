import { test, expect, password } from "@tests/e2e/fixtures";
import { fixtureAuthVars } from "@tests/config/bindings";

test.use({ seeded: false });

test("bootstrap registration clears the password and continues through verification to operator sign-in", async ({
  app,
  page,
}) => {
  const email = "bootstrap-entry@browser.invalid";
  await page.goto(`${app.origin}/bootstrap`);
  await page.getByLabel("Display name", { exact: true }).fill("New operator");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page
    .getByLabel("Setup key", { exact: true })
    .fill(fixtureAuthVars.OPERATOR_BOOTSTRAP_SECRET);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel(/^Password/)).toHaveValue("");
  await expect(
    page.getByRole("textbox", { name: "Email", exact: true }),
  ).toHaveValue(email);
  const verification = await page.context().newPage();
  await verification.goto(
    `${app.origin}/verify-email?token=${await app.mailedToken("verify-email", email)}`,
  );
  await verification
    .getByRole("button", { name: "Verify email", exact: true })
    .click();
  await expect(
    verification.getByRole("heading", { name: "Email verified", exact: true }),
  ).toBeVisible();
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Account options", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});
