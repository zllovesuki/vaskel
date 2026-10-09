import { randomUUID } from "node:crypto";
import {
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import {
  test,
  expect,
  roomPath,
  apiPath,
  type Room,
} from "@tests/e2e/fixtures";
import { apiErrorResponse, deferred, fulfillHeld } from "@tests/e2e/helpers";
import { coldContext, hold, announcement } from "./workspace-fixture";

const unavailable = "This conversation isn’t available";
const desktop = { width: 1280, height: 900 };

test("a cold destination beyond the first real directory page opens without scanning continuations", async ({
  app,
  browser,
}) => {
  test.setTimeout(120_000);
  // Exercise an ordinary configured instance with more than one page of circles.
  await app.server.update((options) => ({
    ...options,
    workers: options.workers.map((worker, index) =>
      index === 0 && "configPath" in worker
        ? {
            ...worker,
            vars: { ...worker.vars, INSTANCE_SERVER_LIMIT: "64" },
            secrets: { ...worker.secrets, INSTANCE_SERVER_LIMIT: "64" },
          }
        : worker,
    ),
  }));
  const rooms: Room[] = [];
  for (let index = 0; index < 50; index += 1) {
    const result = ResourceCreatedSchema.parse(
      (
        await app.request(app.owner, "/api/servers", {
          commandId: randomUUID(),
          name: `Discovery ${index}`,
          firstChannelName: "General",
        })
      ).result,
    );
    if (result.kind !== "created") throw new Error(result.kind);
    rooms.push({
      owner: result.owner,
      channelId: result.channelId,
      name: "General",
    });
  }
  const listed = ResourceDirectorySchema.parse(
    (await app.request(app.owner, "/api/directory")).result,
  );
  if (listed.kind !== "directory") throw new Error(listed.kind);
  expect(listed.partial).toBe(false);
  expect(listed.nextCursor).not.toBeNull();
  const target = rooms.find(
    (room) =>
      !listed.resources.some((resource) => resource.owner.id === room.owner.id),
  );
  expect(target).toBeDefined();
  const room = target!;
  const message = await app.send(
    app.owner,
    room,
    "Direct destination outside the loaded page",
  );
  const context = await coldContext(browser, app, app.owner, desktop);
  try {
    const page = await context.newPage();
    await page.clock.install();
    const continuations: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/directory" && url.searchParams.has("after"))
        continuations.push(url.search);
    });
    const destination = await hold(page, `**${apiPath(room)}`);
    const snapshot = await hold(page, `**${apiPath(room)}/snapshot*`);
    await page.goto(`${app.origin}${roomPath(room)}`);
    await destination.reached;
    await expect(page.locator('[data-skeleton="timeline"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Account options", exact: true }),
    ).toBeVisible();
    expect(continuations).toEqual([]);
    destination.release();
    await snapshot.reached;
    await expect(page.locator('[data-skeleton="timeline"]')).toBeVisible();
    snapshot.release();
    await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
    expect(continuations).toEqual([]);
    const composer = page.getByRole("textbox", { name: /^Message / });
    await composer.fill("Keep this draft through metadata refresh");
    const metadata = DirectoryOutcomeSchema.parse(
      (await app.request(app.owner, apiPath(room))).result,
    );
    if (metadata.kind !== "directory") throw new Error(metadata.kind);
    await app.request(app.owner, `/api/servers/${room.owner.id}/rename`, {
      name: "Renamed outside the loaded page",
      expectedVersion: metadata.version,
    });
    await expect(
      page
        .getByText("Renamed outside the loaded page", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(composer).toHaveValue(
      "Keep this draft through metadata refresh",
    );
    expect(continuations).toEqual([]);
    // A direct-read outage must not stop the existing discovery repair cycle.
    await page.unroute(`**${apiPath(room)}`);
    await page.route(`**${apiPath(room)}`, (route) =>
      route.fulfill(apiErrorResponse("UNAVAILABLE")),
    );
    await page.clock.fastForward(61_000);
    await expect.poll(() => continuations.length).toBeGreaterThan(0);
    await expect(composer).toHaveValue(
      "Keep this draft through metadata refresh",
    );
  } finally {
    await context.close();
  }
});

test("a cold direct link opens an authorized owner missing from the membership index", async ({
  app,
  browser,
}) => {
  const room = await app.room("Unindexed destination");
  const message = await app.send(
    app.owner,
    room,
    "Membership exists before directory publication",
  );
  // Reproduce the intermediate index state covered by the native actor-commit proof.
  const { IDENTITY_DB } = await app.server
    .getWorker<{
      IDENTITY_DB: {
        prepare(sql: string): {
          bind(...values: string[]): { run(): Promise<unknown> };
        };
      };
    }>()
    .getEnv();
  await IDENTITY_DB.prepare(
    "DELETE FROM resource_membership_index WHERE resource_id = ? AND user_id = ?",
  )
    .bind(room.owner.id, app.member.profile.userId)
    .run();
  const before = ResourceDirectorySchema.parse(
    (await app.request(app.member, "/api/directory")).result,
  );
  if (before.kind !== "directory") throw new Error(before.kind);
  expect(before.resources.map((resource) => resource.owner.id)).not.toContain(
    room.owner.id,
  );
  const context = await coldContext(browser, app, app.member, desktop);
  try {
    const page = await context.newPage();
    await page.goto(`${app.origin}${roomPath(room)}`);
    await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
    const after = ResourceDirectorySchema.parse(
      (await app.request(app.member, "/api/directory")).result,
    );
    if (after.kind !== "directory") throw new Error(after.kind);
    // Opening the destination is a read, not an implicit membership-index write.
    expect(after.resources.map((resource) => resource.owner.id)).not.toContain(
      room.owner.id,
    );
  } finally {
    await context.close();
  }
});

test("a missing explicit channel is unavailable while its authorized sibling remains navigable", async ({
  app,
  browser,
}) => {
  const room = await app.room("Accessible sibling");
  const message = await app.send(
    app.owner,
    room,
    "Open the authorized sibling",
  );
  const context = await coldContext(browser, app, app.member, desktop);
  try {
    const page = await context.newPage();
    await page.goto(
      `${app.origin}/servers/${room.owner.id}/channels/${randomUUID()}`,
    );
    await expect(
      page.getByRole("heading", { name: unavailable }),
    ).toBeVisible();
    await page.locator(`a[href="${roomPath(room)}"]`).click();
    await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a late direct lookup cannot replace a later selected conversation", async ({
  app,
  page,
}) => {
  const room = await app.room("Slow destination");
  const dm = await app.send(
    app.owner,
    app.dm,
    "The selected direct conversation",
  );
  await page.clock.install();
  await app.open(page, app.member, roomPath(app.dm));
  await expect(page.getByText(dm.body!, { exact: true })).toBeVisible();
  const gate = deferred();
  const reached = deferred();
  const delivered = deferred();
  await page.route(`**${apiPath(room)}`, async (route) => {
    const response = await route.fetch();
    reached.resolve();
    await gate.promise;
    await fulfillHeld(route, response);
    delivered.resolve();
  });
  try {
    const circle = page.getByRole("button", {
      name: /^Browser Circle(?:\s|$)/,
    });
    if ((await circle.getAttribute("aria-expanded")) === "false")
      await circle.click();
    await page.locator(`a[href="${roomPath(room)}"]`).click();
    await reached.promise;
    await expect(page.getByRole("heading", { name: unavailable })).toBeHidden();
    await page
      .getByRole("navigation", { name: "Direct messages", exact: true })
      .locator(`a[href="${roomPath(app.dm)}"]`)
      .click();
    await expect(page.getByText(dm.body!, { exact: true })).toBeVisible();
    gate.resolve();
    await delivered.promise;
    await expect(page).toHaveURL(`${app.origin}${roomPath(app.dm)}`);
    await expect(page.getByText(dm.body!, { exact: true })).toBeVisible();
  } finally {
    gate.resolve();
  }
});

test("a missing conversation shows the skeleton first and its unavailable view after the check", async ({
  app,
  browser,
}) => {
  const context = await coldContext(browser, app, app.member, desktop);
  try {
    const page = await context.newPage();
    const id = randomUUID();
    const directory = await hold(page, `**/api/resources/conversation/${id}`);
    await page.goto(`${app.origin}/conversations/${id}`);
    await directory.reached;
    await expect(page.locator('[data-skeleton="timeline"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: unavailable })).toBeHidden();
    directory.release();
    await expect(
      page.getByRole("heading", { name: unavailable }),
    ).toBeVisible();
    await expect(announcement(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Account options", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a remembered media default preserves its shell through URL canonicalization", async ({
  app,
  browser,
}) => {
  const room = await app.room("Remembered voice", "media");
  const context = await coldContext(browser, app, app.member, desktop);
  await context.addInitScript(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    {
      key: `vaskel.place:${app.member.profile.userId}`,
      value: { owner: room.owner, channelId: room.channelId },
    },
  );
  try {
    const page = await context.newPage();
    const directory = await hold(page, "**/api/directory*");
    const metadata = await hold(page, `**${apiPath(room)}`);
    await page.goto(app.origin);
    await directory.reached;
    const shell = await page.locator("[data-navigation-open]").elementHandle();
    if (!shell) throw new Error("Workspace did not mount");
    directory.release();
    await metadata.reached;
    await expect(page).toHaveURL(`${app.origin}${roomPath(room)}`);
    await expect(
      page.getByRole("button", { name: "Account options", exact: true }),
    ).toBeVisible();
    expect(await shell.evaluate((element) => element.isConnected)).toBe(true);
    metadata.release();
    await expect(
      page.getByRole("heading", { name: room.name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(announcement(page)).toHaveCount(0);
    expect(await shell.evaluate((element) => element.isConnected)).toBe(true);
    await shell.dispose();
  } finally {
    await context.close();
  }
});
