import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { apiErrorResponse } from "@tests/e2e/helpers";

const meme = {
  name: "reaction.gif",
  mimeType: "image/gif",
  buffer: Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
};
const clip = fileURLToPath(new URL("./files/clip.webm", import.meta.url));

async function attachAndSend(
  page: Page,
  file: string | typeof meme,
  body = "",
) {
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(file);
  await expect(page.getByText("Ready", { exact: false })).toBeVisible();
  if (body) await page.getByRole("textbox", { name: /^Message / }).fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
const naturalWidth = (image: ReturnType<Page["locator"]>) =>
  image.evaluate((element: HTMLImageElement) => element.naturalWidth);

test("an inline image opens the viewer from its granted URL and Escape returns to the preview", async ({
  app,
  page,
}) => {
  const room = await app.room("Viewer image");
  await app.open(page, app.member, roomPath(room));
  await attachAndSend(page, meme);
  await expect(
    page.locator('img[alt="Image preview of reaction.gif"]'),
  ).toHaveAttribute("src", /\/api\/files\//);
  const preview = page.getByRole("button", {
    name: "Preview reaction.gif",
    exact: true,
  });
  await preview.click();
  const dialog = page.getByRole("dialog", {
    name: "reaction.gif",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  await expect
    .poll(() => naturalWidth(dialog.locator('img[src*="/api/files/"]')))
    .toBe(1);
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("link", { name: "Download reaction.gif", exact: true }),
  ).toHaveAttribute("href", /\/api\/files\//);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(preview).toBeFocused();
});

test("a video thumbnail opens the viewer and playback uses the original byte ranges", async ({
  app,
  page,
}) => {
  const room = await app.room("Viewer video");
  await app.open(page, app.member, roomPath(room));
  await attachAndSend(page, clip);
  const play = page.getByRole("button", {
    name: "Play clip.webm",
    exact: true,
  });
  await expect(play).toHaveCount(1);
  const thumbnail = page.locator('img[alt="Image preview of clip.webm"]');
  await expect(thumbnail).toHaveAttribute(
    "src",
    /\/api\/files\/[^/]+\/thumbnail$/,
  );
  await expect.poll(() => naturalWidth(thumbnail)).toBe(64);
  await page.setViewportSize({ width: 390, height: 844 });
  await play.scrollIntoViewIfNeeded();
  await expect(play).toBeVisible();
  const ranged = page.waitForResponse(
    (response) =>
      response.url().includes("/api/files/") &&
      response.request().headers()["range"] !== undefined,
  );
  await play.click();
  const dialog = page.getByRole("dialog", { name: "clip.webm", exact: true });
  const video = dialog.locator("video");
  await expect(video).toBeVisible();
  await expect(video).toBeFocused();
  const response = await ranged;
  expect(response.status()).toBe(206);
  expect(response.headers()["content-type"]).toBe("video/webm");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  // Browser autoplay policy stays as shipped: a refused start is usable from the keyboard.
  if (await video.evaluate((element: HTMLVideoElement) => element.paused))
    await page.keyboard.press("Space");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(play).toBeFocused();
});

test("a missing thumbnail keeps the video tile playable and the original downloadable", async ({
  app,
  page,
}) => {
  const room = await app.room("Thumbnail fallback");
  await app.open(page, app.member, roomPath(room));
  await page.route("**/api/files/*/thumbnail", (route) =>
    route.fulfill({ status: 404 }),
  );
  const missing = page.waitForResponse((response) =>
    response.url().endsWith("/thumbnail"),
  );
  await attachAndSend(page, clip);
  expect((await missing).status()).toBe(404);
  await expect(
    page.locator('img[alt="Image preview of clip.webm"]'),
  ).toHaveCount(0);
  const play = page.getByRole("button", {
    name: "Play clip.webm",
    exact: true,
  });
  await expect(play).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Download clip.webm", exact: true }),
  ).toHaveAttribute("href", /\/api\/files\/[^/]+$/);
  await play.click();
  const video = page
    .getByRole("dialog", { name: "clip.webm", exact: true })
    .locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(play).toBeFocused();
});

test("channel switches reuse successful and unsupported thumbnails without network transfers", async ({
  app,
  page,
}) => {
  const room = await app.room("Cached thumbnails");
  const other = await app.room("Other channel");
  await app.open(page, app.member, roomPath(room));
  // Chromium reports nonzero Resource Timing transfer sizes for cached 404s.
  const network = await page.context().newCDPSession(page);
  const thumbnails: { status: number; cached: boolean }[] = [];
  await network.send("Network.enable");
  network.on(
    "Network.responseReceived",
    ({
      response,
    }: {
      response: { url: string; status: number; fromDiskCache?: boolean };
    }) => {
      if (response.url.endsWith("/thumbnail"))
        thumbnails.push({
          status: response.status,
          cached: response.fromDiskCache === true,
        });
    },
  );
  await page.getByLabel("Attach files", { exact: true }).setInputFiles([
    { name: "clip.webm", mimeType: "video/webm", buffer: await readFile(clip) },
    {
      name: "unsupported.mp4",
      mimeType: "video/mp4",
      buffer: await readFile(
        new URL(
          "../../apps/server/tests/fixtures/thumbnail-pq.mp4.bin",
          import.meta.url,
        ),
      ),
    },
  ]);
  await expect(page.getByText("Ready", { exact: false })).toHaveCount(2);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const ready = async () => {
    await expect
      .poll(() =>
        naturalWidth(page.locator('img[alt="Image preview of clip.webm"]')),
      )
      .toBe(64);
    await expect(
      page.getByRole("button", { name: "Play unsupported.mp4", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('img[alt="Image preview of unsupported.mp4"]'),
    ).toHaveCount(0);
  };
  await ready();
  expect(thumbnails).toHaveLength(2);
  expect(thumbnails).toEqual(
    expect.arrayContaining([
      { status: 200, cached: false },
      { status: 404, cached: false },
    ]),
  );

  thumbnails.length = 0;
  await page.locator(`a[href="${roomPath(other)}"]`).click();
  await expect(
    page.getByRole("button", { name: "Play clip.webm", exact: true }),
  ).toHaveCount(0);
  await page.locator(`a[href="${roomPath(room)}"]`).click();
  await ready();
  expect(thumbnails.filter((response) => !response.cached)).toEqual([]);
  await network.detach();
});

test("the viewer opens above the original-message dialog and Escape closes only the viewer", async ({
  app,
  page,
}) => {
  const a = await app.room("Viewer origin");
  const b = await app.room("Viewer target");
  await app.open(page, app.member, roomPath(a));
  await attachAndSend(page, meme, "Forward this picture");
  const row = page.locator("[data-timeline-sequence]").last();
  await expect(row).toContainText("Forward this picture");
  await row.hover();
  await row.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Forward", exact: true }).click();
  const picker = page.getByRole("dialog");
  await picker
    .getByRole("combobox", { name: "Send to", exact: true })
    .selectOption(`server:${b.owner.id}`);
  await picker
    .getByRole("combobox", { name: "Room", exact: true })
    .selectOption(b.channelId);
  await picker.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}${roomPath(b)}`);
  await page
    .getByRole("textbox", { name: /^Message / })
    .fill("See the original");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("button", { name: "Open original", exact: true })
    .click();
  const original = page.getByRole("dialog", {
    name: "Original message",
    exact: true,
  });
  const preview = original.getByRole("button", {
    name: "Preview reaction.gif",
    exact: true,
  });
  await preview.click();
  await expect(page.locator("dialog:modal")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  await expect(original).toBeVisible();
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog:modal")).toHaveCount(0);
});

test("a refused grant leaves the conversation usable and Try again recovers", async ({
  app,
  page,
}) => {
  const room = await app.room("Viewer refusal");
  await app.open(page, app.member, roomPath(room));
  const grants = `**${apiPath(room)}/files/*/grant`;
  let refusals = 0;
  await page.route(grants, (route) => {
    refusals++;
    return route.fulfill(apiErrorResponse("NOT_FOUND"));
  });
  await attachAndSend(page, meme, "Picture with a missing file");
  const row = page
    .locator("[data-timeline-sequence]")
    .filter({ hasText: "Picture with a missing file" });
  await expect(
    row.getByText("Image preview unavailable", { exact: true }),
  ).toBeVisible();
  const retry = row.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  await expect(row).toContainText("reaction.gif");
  expect(refusals).toBeGreaterThan(0);
  // A missing file is local to its row: the conversation keeps working.
  await page.getByRole("textbox", { name: /^Message / }).fill("Still usable");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Still usable", { exact: true })).toBeVisible();
  await expect(row).toContainText("Picture with a missing file");
  await page.unroute(grants);
  await retry.click();
  await expect(
    row.locator('img[alt="Image preview of reaction.gif"]'),
  ).toHaveAttribute("src", /\/api\/files\//);
  await expect(
    row.getByRole("link", { name: "Download reaction.gif", exact: true }),
  ).toHaveAttribute("href", /\/api\/files\//);
});

test("reopening after the grant wears out asks for a new grant and still loads", async ({
  app,
  page,
}) => {
  const room = await app.room("Viewer expiry");
  await app.open(page, app.member, roomPath(room));
  let grants = 0;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(`${apiPath(room)}/files/`) && url.endsWith("/grant"))
      grants++;
  });
  await attachAndSend(page, meme);
  const preview = page.getByRole("button", {
    name: "Preview reaction.gif",
    exact: true,
  });
  await preview.click();
  const dialog = page.getByRole("dialog", {
    name: "reaction.gif",
    exact: true,
  });
  await expect.poll(() => naturalWidth(dialog.locator("img"))).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const issued = grants;
  expect(issued).toBeGreaterThan(0);
  // An hour later the held grant is worn out; opening asks for a new one and
  // the image still loads. The URL may repeat within one server second.
  await page.clock.setFixedTime(Date.now() + 61 * 60_000);
  await preview.click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => grants).toBeGreaterThan(issued);
  await expect.poll(() => naturalWidth(dialog.locator("img"))).toBe(1);
});

test("grant failures surface inside the viewer with Try again", async ({
  app,
  page,
}) => {
  const room = await app.room("Viewer refresh");
  await app.open(page, app.member, roomPath(room));
  await attachAndSend(page, meme);
  const preview = page.getByRole("button", {
    name: "Preview reaction.gif",
    exact: true,
  });
  await expect(preview).toBeVisible();
  const grants = `**${apiPath(room)}/files/*/grant`;
  await page.route(grants, (route) =>
    route.fulfill(apiErrorResponse("NOT_FOUND")),
  );
  // The held grant is worn out, so opening must refresh it; the refusal shows in the viewer.
  await page.clock.setFixedTime(Date.now() + 61 * 60_000);
  await preview.click();
  const dialog = page.getByRole("dialog", {
    name: "reaction.gif",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Image preview unavailable", { exact: true }),
  ).toBeVisible();
  await page.unroute(grants);
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => naturalWidth(dialog.locator("img"))).toBe(1);
  // A download refresh that fails while the image stays adds its own notice.
  await page.clock.setFixedTime(Date.now() + 122 * 60_000);
  await page.route(grants, (route) =>
    route.fulfill(apiErrorResponse("NOT_FOUND")),
  );
  await dialog
    .getByRole("link", { name: "Download reaction.gif", exact: true })
    .click();
  await expect(
    dialog.getByText("Download unavailable", { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator("img")).toBeVisible();
  await page.unroute(grants);
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    dialog.getByText("Download unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.locator("img")).toBeVisible();
});
