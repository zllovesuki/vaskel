import { CrossSearchResponseSchema } from "@vaskel/contracts/search";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { test, expect, apiPath } from "@tests/e2e/fixtures";

test("live search pages, Refresh and known access loss use the current owners", async ({
  app,
  page,
}) => {
  for (let index = 0; index < 25; index++)
    await app.sendReceipt(
      app.owner,
      app.circle,
      `BrowserNeedle message ${String(index).padStart(2, "0")}`,
    );
  await app.open(page, app.member, "/search?q=BrowserNeedle");
  const results = page.getByRole("list", {
    name: "Search results",
    exact: true,
  });
  await expect(results.locator("article")).toHaveCount(20);
  await page.getByRole("button", { name: "More results", exact: true }).click();
  await expect(results.locator("article")).toHaveCount(25);
  await app.sendReceipt(app.owner, app.circle, "BrowserNeedle freshly arrived");
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await expect(results.locator("article")).toHaveCount(20);
  await expect(
    results.getByText("BrowserNeedle freshly arrived", { exact: true }),
  ).toBeVisible();
  const directory = DirectoryOutcomeSchema.parse(
    (await app.request(app.owner, apiPath(app.circle))).result,
  );
  if (directory.kind !== "directory") throw new Error(directory.kind);
  await app.request(
    app.owner,
    `/api/servers/${app.circle.owner.id}/remove-member`,
    { userId: app.member.profile.userId, expectedVersion: directory.version },
  );
  await expect(results).toHaveCount(0);
  // The retained continuation performs current authority checks even after a directory hint.
  await page.getByRole("button", { name: "More results", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "More results", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("BrowserNeedle freshly arrived", { exact: true }),
  ).toHaveCount(0);
});

test("an empty incomplete page explains Refresh and does not automatically drain continuations", async ({
  app,
  page,
}) => {
  await app.sendReceipt(
    app.owner,
    app.circle,
    "IncompleteNeedle recovered message",
  );
  let unavailable = true;
  const requests: { cursor?: string }[] = [];
  await page.route("**/api/account/search", async (route) => {
    requests.push(route.request().postDataJSON() as { cursor?: string });
    if (!unavailable) {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: CrossSearchResponseSchema.parse({
        kind: "cross_matches",
        hits: [],
        deniedServerIds: [],
        unavailableServerIds: [app.circle.owner.id],
        coverage: { limited: false, unavailable: true },
        nextCursor: "retained-position",
      }),
    });
  });
  await app.open(page, app.member, "/search?q=IncompleteNeedle");
  await expect(
    page.getByText("Results are incomplete. Refresh to try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No matching messages.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "More results", exact: true }),
  ).toBeEnabled();
  expect(requests.every((request) => request.cursor === undefined)).toBe(true);
  await page.getByRole("button", { name: "More results", exact: true }).click();
  await expect
    .poll(
      () => requests.filter((request) => request.cursor !== undefined).length,
    )
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "More results", exact: true }),
  ).toBeEnabled();
  unavailable = false;
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await expect(
    page.getByText("IncompleteNeedle recovered message", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.cursor).toBeUndefined();
});
