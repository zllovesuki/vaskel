import { test, expect } from "@tests/e2e/fixtures";
import { deferred } from "@tests/e2e/helpers";

const viewports = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

test("host rebuilds search indexes and sees stream outcomes with stable desktop and mobile controls", async ({
  app,
  page,
}) => {
  await app.send(app.owner, app.circle, "Search rebuild preserves circle text");
  await app.send(app.owner, app.dm, "Search rebuild preserves direct text");
  await app.open(page, app.owner, "/settings/host");
  // Maintenance pairs the running version with the rebuild action.
  const maintenance = page.getByRole("region", {
    name: "Maintenance",
    exact: true,
  });
  const heading = maintenance.getByRole("heading", {
    name: "Search indexes",
    exact: true,
  });
  const button = maintenance.getByRole("button", {
    name: /^(Rebuild all indexes|Rebuilding…)$/,
  });
  await expect(button).toBeEnabled();
  const buttonWidths: number[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await heading.scrollIntoViewIfNeeded();
    await expect(
      maintenance.getByRole("heading", { name: "Version", exact: true }),
    ).toBeVisible();
    // The local runtime has no deploy tag.
    await expect(
      maintenance.getByText("Not recorded", { exact: true }),
    ).toBeVisible();
    buttonWidths.push(
      await button.evaluate((element) => element.getBoundingClientRect().width),
    );
  }
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/operator/search-index/rebuild"
    )
      requests.push(request.method());
  });
  await button.click();
  await expect(
    page.getByText("2 indexes rebuilt.", { exact: true }),
  ).toBeVisible();
  expect(requests).toEqual(["POST"]);
  expect((await app.snapshot(app.owner, app.circle)).messages[0]!.body).toBe(
    "Search rebuild preserves circle text",
  );
  expect((await app.snapshot(app.owner, app.dm)).messages[0]!.body).toBe(
    "Search rebuild preserves direct text",
  );

  // Transport fixtures make waiting and truncated-response states observable.
  const release = deferred();
  await page.route("**/api/operator/search-index/rebuild", async (route) => {
    await release.promise;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: rebuild\ndata: {"type":"progress","rebuilt":1,"failed":0,"indexedMessages":1}\n\n',
    });
  });
  await button.click();
  await expect(button).toBeDisabled();
  for (const [index, viewport] of viewports.entries()) {
    await page.setViewportSize(viewport);
    expect(
      await button.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeCloseTo(buttonWidths[index]!);
  }
  await expect(
    page.getByText("0 completed so far.", { exact: true }),
  ).toBeVisible();
  release.resolve();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Rebuild interrupted. 1 completed." }),
  ).toBeVisible();
  await expect(
    page.getByText("2 indexes rebuilt.", { exact: true }),
  ).toHaveCount(0);
  await expect(button).toBeEnabled();
  await page.unroute("**/api/operator/search-index/rebuild");

  await page.route("**/api/operator/search-index/rebuild", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: rebuild\ndata: {"type":"complete","rebuilt":1,"failed":1,"indexedMessages":1}\n\n',
    }),
  );
  await button.click();
  await expect(
    page.getByText(
      "1 rebuilt. 1 could not be confirmed. You can rebuild again.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    expect(
      await page.locator("body").evaluate((body) => body.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
  }
  await page.unroute("**/api/operator/search-index/rebuild");
  await button.click();
  await expect(
    page.getByText("2 indexes rebuilt.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Rebuild interrupted" }),
  ).toHaveCount(0);
});
