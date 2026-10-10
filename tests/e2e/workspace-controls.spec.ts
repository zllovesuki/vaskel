import { randomUUID } from "node:crypto";
import { ResourceDirectorySchema } from "@vaskel/contracts/directory";
import { test, expect, roomPath } from "@tests/e2e/fixtures";
import { apiErrorResponse, deferred } from "@tests/e2e/helpers";

for (const surface of ["people", "settings"] as const) {
  test(`${surface} waits for owner command settlement and refreshed versions`, async ({
    app,
    page,
  }) => {
    const root = `/api/servers/${app.circle.owner.id}`;
    const allowRole = deferred();
    const roleStarted = deferred();
    const allowRefresh = deferred();
    const refreshStarted = deferred();
    const commands: Array<{ action: string; expectedVersion: number }> = [];
    let refreshing = false;
    await page.route(`**${root}/set-role`, async (route) => {
      const body = route.request().postDataJSON() as {
        expectedVersion: number;
      };
      commands.push({
        action: "set-role",
        expectedVersion: body.expectedVersion,
      });
      roleStarted.resolve();
      await allowRole.promise;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      refreshing = true;
      await route.fulfill({ response });
    });
    await page.route("**/api/directory*", async (route) => {
      if (refreshing) {
        refreshStarted.resolve();
        await allowRefresh.promise;
      }
      await route.continue();
    });
    await page.route(`**${root}/remove-member`, async (route) => {
      const body = route.request().postDataJSON() as {
        expectedVersion: number;
      };
      commands.push({
        action: "remove-member",
        expectedVersion: body.expectedVersion,
      });
      await route.continue();
    });
    await app.open(
      page,
      app.owner,
      `/servers/${app.circle.owner.id}/${surface}`,
    );
    const options = page.getByRole("button", {
      name: "Options for Browser Member",
      exact: true,
    });
    await options.click();
    await page
      .getByRole("menuitem", { name: "Make moderator", exact: true })
      .click();
    await roleStarted.promise;
    try {
      await options.click();
      const remove = page.getByRole("menuitem", {
        name: "Remove from circle",
        exact: true,
      });
      await expect(remove).toBeDisabled();
      await expect(
        page.getByRole("menuitem", { name: "Make moderator", exact: true }),
      ).toBeDisabled();
      expect(commands).toHaveLength(1);
      allowRole.resolve();
      await refreshStarted.promise;
      await expect(remove).toBeDisabled();
      allowRefresh.resolve();
      await expect(remove).toBeEnabled();
      await expect(
        page.getByRole("menuitem", { name: "Remove moderator", exact: true }),
      ).toBeEnabled();
      await remove.click();
      const confirmation = page.getByRole("group", {
        name: "Remove Browser Member from this circle?",
        exact: true,
      });
      const removed = page.waitForResponse((response) =>
        response.url().endsWith(`${root}/remove-member`),
      );
      await confirmation
        .getByRole("button", { name: "Remove from circle", exact: true })
        .click();
      expect((await removed).status()).toBe(200);
      await expect(options).toHaveCount(0);
      expect(commands).toHaveLength(2);
      expect(commands[1]!.expectedVersion).toBeGreaterThan(
        commands[0]!.expectedVersion,
      );
    } finally {
      allowRole.resolve();
      allowRefresh.resolve();
    }
  });
}

for (const reply of ["accepted", "unavailable"] as const) {
  test(`invitation creation refreshes after closing its dialog with an ${reply} reply`, async ({
    app,
    page,
  }) => {
    const path = `/api/servers/${app.circle.owner.id}/invites`;
    const allowCreate = deferred();
    const createStarted = deferred();
    const events: string[] = [];
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() === "POST") {
        createStarted.resolve();
        await allowCreate.promise;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        events.push("committed");
        if (reply === "accepted") await route.fulfill({ response });
        else await route.fulfill(apiErrorResponse("UNAVAILABLE"));
      } else {
        events.push("list");
        await route.continue();
      }
    });
    await app.open(page, app.owner, `/servers/${app.circle.owner.id}/settings`);
    const invitations = page.getByRole("region", {
      name: "Invitations",
      exact: true,
    });
    await expect(invitations.getByRole("listitem")).toHaveCount(1);
    await invitations
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Create invitation",
      exact: true,
    });
    // Dismissing an untouched form does not invalidate the metadata list.
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await invitations
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    await createStarted.promise;
    try {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(invitations.getByRole("listitem")).toHaveCount(1);
      allowCreate.resolve();
      await expect(invitations.getByRole("listitem")).toHaveCount(2);
      expect(events).toEqual(["list", "committed", "list"]);
      // The refreshed owner list contains metadata, never the raw invitation link.
      await expect(invitations.getByRole("textbox")).toHaveCount(0);
    } finally {
      allowCreate.resolve();
    }
  });
}

test("the conversation header's Invite opens a modal dialog that Escape closes back to its trigger", async ({
  app,
  page,
}) => {
  await app.open(page, app.owner, roomPath(app.circle));
  const invite = page.getByRole("button", { name: "Invite", exact: true });
  await invite.click();
  const dialog = page.getByRole("dialog", {
    name: "Invite people",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Create invitation", exact: true }),
  ).toBeVisible();
  // A modal dialog, not a popover: the conversation behind it is inert.
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(invite).toBeFocused();
});

test("signed-in entry pages finish access navigation without redirecting", async ({
  app,
  page,
}) => {
  await app.open(page, app.owner, roomPath(app.circle));
  for (const [path, heading] of [
    ["/invite", "This invitation link is incomplete"],
    ["/bootstrap", "Set up vaskel."],
    ["/verify-email", "This verification link is incomplete"],
    ["/reset-password", "Choose a new password"],
    ["/forgot-password", "Reset password"],
  ]) {
    // The inbox is admitted only after the access coordinator reaches online.
    const inbox = page.waitForEvent("websocket", {
      predicate: (socket) => socket.url().endsWith("/api/account/events"),
    });
    await page.goto(`${app.origin}${path}`);
    await expect(
      page.getByRole("heading", { name: heading!, exact: true }),
    ).toBeVisible();
    await inbox;
    expect(new URL(page.url()).pathname).toBe(path);
  }
});

test("signed-in sign-in reveals the shell while Home chooses a destination", async ({
  app,
  page,
}) => {
  const directory = ResourceDirectorySchema.parse(
    (await app.request(app.owner, "/api/directory")).result,
  );
  if (directory.kind !== "directory") throw new Error("Missing directory");
  // Arbitrary resource IDs determine directory order; the circle may follow the DM.
  const first = directory.resources.find(
    (resource) => resource.channels.length,
  );
  const destination = [app.circle, app.dm].find(
    (room) => room.owner.id === first?.owner.id,
  );
  if (!destination) throw new Error("Missing default fixture room");
  // Start with only the fixture cookie: no previous document's late inbox socket.
  await page.context().addCookies(
    app.owner.cookie.split("; ").map((cookie) => {
      const equals = cookie.indexOf("=");
      return {
        name: cookie.slice(0, equals),
        value: cookie.slice(equals + 1),
        url: app.origin,
      };
    }),
  );
  const allowDirectory = deferred();
  const directoryStarted = deferred();
  await page.route("**/api/directory*", async (route) => {
    directoryStarted.resolve();
    await allowDirectory.promise;
    await route.continue();
  });
  let inboxes = 0;
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/api/account/events")) inboxes++;
  });
  try {
    await page.goto(`${app.origin}/sign-in`);
    await directoryStarted.promise;
    await expect(page.locator('[data-skeleton="timeline"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Account options", exact: true }),
    ).toBeVisible();
    // Account services can connect while the default destination is loading.
    await expect.poll(() => inboxes).toBe(1);
    allowDirectory.resolve();
    await expect(
      page.getByRole("heading", { name: destination.name, exact: true }),
    ).toBeVisible();
    await expect.poll(() => inboxes).toBe(1);
    expect(new URL(page.url()).pathname).toBe(roomPath(destination));
  } finally {
    allowDirectory.resolve();
  }
});

test("mobile navigation restores focus on every workspace surface", async ({
  app,
  page,
}) => {
  const voice = await app.room("Navigation voice room", "media");
  await app.open(page, app.owner, roomPath(app.circle));
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open conversations", exact: true })
    .click();
  const circleActions = page.getByRole("button", {
    name: "Circle actions",
    exact: true,
  });
  await circleActions.click();
  await page.getByRole("menuitem", { name: "Add a room", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create a room in Browser Circle",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Room name" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(circleActions).toBeFocused();
  for (const path of [
    roomPath(app.circle),
    roomPath(voice),
    `/servers/${app.circle.owner.id}/people`,
    `/servers/${app.circle.owner.id}/settings`,
    "/settings/account",
    "/settings/blocked",
    "/settings/host",
    "/search",
    `/servers/${app.circle.owner.id}/channels/${randomUUID()}`,
  ]) {
    await page.goto(`${app.origin}${path}`);
    const toggle = page.getByRole("button", {
      name: /^(Open conversations|Conversations)$/,
    });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const close = page.getByRole("button", {
      name: "Close conversations",
      exact: true,
    });
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await toggle.click();
    await close.click();
    await expect(toggle).toBeFocused();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  }
});
