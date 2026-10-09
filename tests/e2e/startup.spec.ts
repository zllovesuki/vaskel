import { apiErrorResponse } from "@tests/e2e/helpers";
import type { Page } from "@playwright/test";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { coldContext, hold, announcement } from "./workspace-fixture";

const unavailable = "This conversation isn’t available";
const reconnecting = "Reconnecting and checking your conversations…";
const connectionLost = "Connection lost. You can still read open messages.";
const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };

/** The visible frame during account loading, local loading and usable content. */
async function frame(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = [...document.querySelectorAll(selector)].at(-1);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      sidebar: box('[data-skeleton="sidebar"]') ?? box("aside"),
      header: box('[data-skeleton="header"]') ?? box("main header"),
      composer: box('[data-skeleton="composer"]') ?? box("[data-composer]"),
    };
  });
}

for (const [label, viewport] of [
  ["desktop", desktop],
  ["phone", phone],
] as const) {
  test(`a cold deep link reveals independent workspace sections on ${label}`, async ({
    app,
    browser,
  }) => {
    // The skeleton reproduces a one-line room title; a name that wraps beside the
    // phone's touch-size header controls would make the real header taller.
    const room = await app.room(`Cold ${label}`);
    const message = await app.send(
      app.owner,
      room,
      `Cold start is ready on ${label}`,
    );
    const context = await coldContext(browser, app, app.member, viewport);
    try {
      const page = await context.newPage();
      const identity = await hold(page, "**/api/identity/me");
      const directory = await hold(page, "**/api/directory*");
      const metadata = await hold(page, `**${apiPath(room)}`);
      const snapshot = await hold(page, `**${apiPath(room)}/snapshot*`);
      await page.goto(`${app.origin}${roomPath(room)}`);
      await identity.reached;
      await expect(announcement(page)).toBeVisible();
      const first = await frame(page);
      expect(first.header).not.toBeNull();
      identity.release();
      await directory.reached;
      await metadata.reached;
      await expect(announcement(page)).toHaveCount(0);
      await expect(page.locator('[data-skeleton="timeline"]')).toBeVisible();
      const shell = await page
        .locator("[data-navigation-open]")
        .elementHandle();
      if (!shell) throw new Error("Workspace did not mount");
      if (label === "phone")
        await page
          .getByRole("button", { name: "Conversations", exact: true })
          .click();
      await expect(
        page.getByRole("button", { name: "Account options", exact: true }),
      ).toBeVisible();
      await expect(page.locator('[data-skeleton="directory"]')).toBeVisible();
      if (label === "phone") {
        await page
          .getByRole("button", { name: "Close conversations", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Conversations", exact: true }),
        ).toBeFocused();
      }
      metadata.release();
      // The selected snapshot starts while directory discovery is still held.
      await snapshot.reached;
      await expect(
        page.getByRole("heading", { name: room.name, exact: true }),
      ).toBeVisible();
      await expect(page.locator('[data-skeleton="timeline"]')).toBeVisible();
      await expect(
        page.getByRole("heading", { name: unavailable }),
      ).toBeHidden();
      await expect(page.getByText(reconnecting)).toBeHidden();
      const beforeMessages = await frame(page);
      snapshot.release();
      await expect(
        page.getByText(message.body!, { exact: true }),
      ).toBeVisible();
      await expect(announcement(page)).toHaveCount(0);
      await expect(page.locator('[data-skeleton="header"]')).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: /^Message / }),
      ).toBeEnabled();
      await expect(page.locator('[data-skeleton="directory"]')).toHaveCount(1);
      directory.release();
      await expect(page.locator('[data-skeleton="directory"]')).toHaveCount(0);
      await expect(page.getByText(reconnecting)).toBeHidden();
      expect(await frame(page)).toEqual(beforeMessages);
      expect(await shell.evaluate((element) => element.isConnected)).toBe(true);
      await shell.dispose();
    } finally {
      await context.close();
    }
  });
}

for (const failure of ["network", "metadata", "snapshot"] as const) {
  test(`a failed ${failure} destination read can retry without changing account`, async ({
    app,
    browser,
  }) => {
    const room = await app.room("Interrupted destination");
    const message = await app.send(app.owner, room, "Destination recovered");
    const context = await coldContext(browser, app, app.member, desktop);
    try {
      const page = await context.newPage();
      let interrupted = false;
      await page.route(
        `**${apiPath(room)}${failure === "snapshot" ? "/snapshot" : ""}`,
        async (route) => {
          if (interrupted) return route.continue();
          interrupted = true;
          if (failure === "network") await route.abort("failed");
          else
            await route.fulfill({
              ...apiErrorResponse("INTERNAL_SERVER_ERROR"),
              headers: { "X-Request-ID": "startup-error-reference" },
              json: {
                ...apiErrorResponse("INTERNAL_SERVER_ERROR").json,
                message: "private backend detail",
              },
            });
        },
      );
      await page.goto(`${app.origin}${roomPath(room)}`);
      if (failure !== "network") {
        await expect(
          page.getByText(
            "The request could not be completed. Please try again. Reference: startup-error-reference",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(page.getByText("private backend detail")).toHaveCount(0);
      }
      await expect(
        page.getByRole("button", { name: "Account options", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(connectionLost)).toBeHidden();
      await expect(
        page.getByRole("heading", { name: unavailable }),
      ).toBeHidden();
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(
        page.getByText(message.body!, { exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

for (const failure of ["network", "server"] as const) {
  test(`directory ${failure} failure stays in the sidebar while a known room works`, async ({
    app,
    browser,
  }) => {
    const room = await app.room("Independent destination");
    const message = await app.send(
      app.owner,
      room,
      "Readable without directory discovery",
    );
    const context = await coldContext(browser, app, app.member, desktop);
    try {
      const page = await context.newPage();
      let failing = true;
      await page.route("**/api/directory*", async (route) => {
        if (!failing) return route.continue();
        if (failure === "network") await route.abort("failed");
        else await route.fulfill(apiErrorResponse("UNAVAILABLE"));
      });
      await page.goto(`${app.origin}${roomPath(room)}`);
      await expect(
        page.getByText(message.body!, { exact: true }),
      ).toBeVisible();
      const composer = page.getByRole("textbox", { name: /^Message / });
      await expect(composer).toBeEnabled();
      await composer.fill("Send while discovery is unavailable");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByText("Send while discovery is unavailable", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(connectionLost)).toBeHidden();
      const sidebar = page.getByRole("complementary", {
        name: "Conversations",
        exact: true,
      });
      await expect(sidebar.getByRole("alert")).toBeVisible();
      failing = false;
      await sidebar
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(sidebar.getByRole("alert")).toHaveCount(0);
      await expect(composer).toBeEnabled();
    } finally {
      await context.close();
    }
  });
}

test("account settings remains usable while directory discovery is held", async ({
  app,
  page,
}) => {
  const directory = await hold(page, "**/api/directory*");
  const ownerReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/resources/"))
      ownerReads.push(request.url());
  });
  try {
    await app.open(page, app.member, "/settings/account");
    await directory.reached;
    await expect(
      page.getByRole("heading", { name: "Account settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Display name", exact: true }),
    ).toBeEnabled();
    expect(ownerReads).toEqual([]);
  } finally {
    directory.release();
  }
});
