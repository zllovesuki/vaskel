import { test, expect, password, roomPath } from "@tests/e2e/fixtures";

test("public instance branding appears before sign-in at the preserved conversation destination", async ({
  app,
  page,
}) => {
  const instanceName = "Browser community";
  await app.request(app.owner, "/api/operator/instance", {
    name: instanceName,
    invitePolicy: "members",
  });
  const sent = await app.send(
    app.owner,
    app.circle,
    "Return to the requested conversation",
  );
  const target = roomPath(app.circle);
  await page.goto(`${app.origin}${target}`);
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(instanceName, { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(target);
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(app.member.email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(sent.body!, { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(target);
});
