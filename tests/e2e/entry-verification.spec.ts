import { test, expect } from "@tests/e2e/fixtures";
import { unverified, fitsPhone } from "@tests/e2e/entry-fixture";
import { deferred } from "@tests/e2e/helpers";

test("a cold verification route keeps the entry frame while its chunk loads", async ({
  app,
  page,
}) => {
  const token = await unverified(app);
  const reached = deferred();
  const release = deferred();
  await page.route("**/assets/verification-*.js", async (route) => {
    reached.resolve();
    await release.promise;
    await route.continue();
  });
  const identity = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/identity/me",
  );
  try {
    await page.goto(`${app.origin}/verify-email?token=${token}`, {
      waitUntil: "domcontentloaded",
    });
    await reached.promise;
    await (await identity).finished();
    // Inspect the next painted frame after identity settles, rather than
    // accepting the root's earlier identity-loading placeholder.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const opening = page.locator('[data-skeleton="auth"]');
    await expect(opening).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Verify email", exact: true }),
    ).toHaveCount(0);
    release.resolve();
    await expect(
      page.getByRole("button", { name: "Verify email", exact: true }),
    ).toBeVisible();
    await expect(opening).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

test("verification distinguishes incomplete, retryable and spent links on a phone", async ({
  app,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  for (const path of ["/verify-email", "/verify-email?token=abc"]) {
    await page.goto(`${app.origin}${path}`);
    const heading = page.getByRole("heading", {
      name: "This verification link is incomplete",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(heading).not.toBeFocused();
    await expect(
      page.getByRole("button", { name: "Verify email" }),
    ).toHaveCount(0);
    await expect(signIn).toBeVisible();
    await fitsPhone(page);
  }

  // A lost connection leaves the link usable; the retry verifies.
  const token = await unverified(app);
  await page.goto(`${app.origin}/verify-email?token=${token}`);
  await page.route("**/api/identity/verify-email", (route) => route.abort(), {
    times: 1,
  });
  const verify = page.getByRole("button", {
    name: "Verify email",
    exact: true,
  });
  await verify.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(
    page.getByRole("heading", { name: "Email verified", exact: true }),
  ).toBeFocused();
  await expect(signIn).toBeVisible();
  await fitsPhone(page);

  // The used link cannot verify again.
  await page.goto(`${app.origin}/verify-email?token=${token}`);
  await verify.click();
  await expect(
    page.getByRole("heading", {
      name: "This verification link can’t be used",
      exact: true,
    }),
  ).toBeFocused();
  await expect(signIn).toBeVisible();
  await fitsPhone(page);
});
