import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { ResourceCreatedSchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import {
  test,
  expect,
  roomPath,
  apiPath,
  type Room,
} from "@tests/e2e/fixtures";
import { deferred, fulfillHeld } from "@tests/e2e/helpers";

test("invitation controls follow live member capabilities on chat and People", async ({
  app,
  page,
}) => {
  const room = await app.room("Invitation policy");
  await app.invitePolicy(true);
  try {
    await app.open(page, app.member, roomPath(room));
    await expect(
      page.getByRole("button", { name: "Invite", exact: true }),
    ).toBeVisible();
    await app.invitePolicy(false);
    await expect(
      page.getByRole("button", { name: "Invite", exact: true }),
    ).toHaveCount(0);
    await page.goto(`${app.origin}/servers/${room.owner.id}/people`);
    await expect(
      page.getByRole("heading", { name: "People", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Invite people", exact: true }),
    ).toHaveCount(0);
    await app.invitePolicy(true);
    await expect(
      page.getByRole("button", { name: "Invite people", exact: true }),
    ).toBeVisible();
  } finally {
    await app.invitePolicy(false);
  }
});

test("moderator Delete follows current authority while Edit remains author-only", async ({
  app,
  page,
}) => {
  const room = await app.room("Moderation");
  const message = await app.send(
    app.owner,
    room,
    "Moderator can remove this message",
  );
  await app.role("moderator");
  try {
    await app.open(page, app.member, roomPath(room));
    const row = page.getByRole("article").filter({ hasText: message.body! });
    await row.hover();
    await row.getByRole("button", { name: "More", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Edit message", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "Delete message", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    await row
      .getByRole("button", { name: "Delete message", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          typeof (await app.snapshot(app.member, room)).messages.find(
            (row) => row.id === message.id,
          )?.deletedAt === "number",
      )
      .toBe(true);
    await expect(page.getByText(message.body!, { exact: true })).toHaveCount(0);
    const next = await app.send(
      app.owner,
      room,
      "Demoted member cannot remove this",
    );
    await app.role("member");
    await expect(page.getByText(next.body!, { exact: true })).toBeVisible();
    const nextRow = page.getByRole("article").filter({ hasText: next.body! });
    await nextRow.hover();
    await nextRow.getByRole("button", { name: "More", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Delete message", exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.role("member");
  }
});

test("ownership transfer keeps the former owner signed in through the administration denial", async ({
  app,
  page,
}) => {
  const created = ResourceCreatedSchema.parse(
    (
      await app.request(app.owner, "/api/servers", {
        commandId: randomUUID(),
        name: "Transferred circle",
        firstChannelName: "Transfer room",
      })
    ).result,
  );
  if (created.kind !== "created")
    throw new Error("Transfer fixture circle unavailable");
  const room: Room = {
    owner: created.owner,
    channelId: created.channelId,
    name: "Transfer room",
  };
  const root = `/api/servers/${room.owner.id}`;
  const invitation = AdministrationOutcomeSchema.parse(
    (
      await app.request(app.owner, `${root}/invites`, {
        expiresAt: Date.now() + 3_600_000,
        maxUses: 1,
      })
    ).result,
  );
  if (invitation.kind !== "invite_created")
    throw new Error("Transfer fixture invitation unavailable");
  await app.request(app.member, "/api/invites/join", {
    token: invitation.token,
  });

  const releaseDirectory = deferred();
  const denied = deferred();
  const transferred = deferred();
  let holdDirectory = false;
  let deniedStatus = 0;
  // Real producer responses; delay metadata refresh so the expected 403 is
  // consumed by the still-mounted administration query before it is disabled.
  // Intercept before opening, and hold responses from reads already in flight too.
  const holdMetadata = async (route: Route) => {
    const response = await route.fetch();
    if (holdDirectory) await releaseDirectory.promise;
    await fulfillHeld(route, response);
  };
  await page.route("**/api/directory*", holdMetadata);
  await page.route(`**${apiPath(room)}`, holdMetadata);
  await page.route(`**${root}/transfer`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
    transferred.resolve();
  });
  await page.route(`**${root}/administration`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
    if (response.status() === 403) {
      deniedStatus = response.status();
      denied.resolve();
    }
  });
  await app.open(page, app.owner, `/servers/${room.owner.id}/settings`);
  await expect(
    page.getByRole("combobox", { name: "New owner", exact: true }),
  ).toBeEnabled();

  try {
    await page
      .getByRole("combobox", { name: "New owner", exact: true })
      .selectOption(app.member.profile.userId);
    const transfer = page.getByRole("button", {
      name: "Transfer ownership",
      exact: true,
    });
    await transfer.click();
    // The question holds the only Transfer ownership while it is open, and
    // Cancel hands focus back to the button that asked.
    await expect(transfer).toHaveCount(1);
    await page
      .getByRole("group", { name: /Make Browser Member the owner/ })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(transfer).toBeFocused();
    await transfer.click();
    holdDirectory = true;
    await page
      .getByRole("group", { name: /Make Browser Member the owner/ })
      .getByRole("button", { name: "Transfer ownership", exact: true })
      .click();
    await Promise.all([transferred.promise, denied.promise]);
    expect(deniedStatus).toBe(403);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "You do not have permission to do that." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Account options", exact: true }),
    ).toBeVisible();
    releaseDirectory.resolve();
    const composer = page.getByRole("textbox", {
      name: /^Message #Transfer room/,
    });
    await expect(composer).toBeEnabled();
    const body = "Former owner remains a member after transfer";
    await composer.fill(body);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        (await app.snapshot(app.owner, room)).messages.some(
          (message) => message.body === body,
        ),
      )
      .toBe(true);
    await app.request(app.member, `${root}/administration`);
  } finally {
    releaseDirectory.resolve();
  }
});
