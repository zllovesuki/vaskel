import { test, expect, roomPath } from "@tests/e2e/fixtures";
import { syntheticMedia } from "@tests/e2e/media-ui-fixture";

test("a held join cancels its exact request and pending cleanup explains why another join must wait", async ({
  app,
  page,
}) => {
  const room = await app.room("Pending call", "media");
  const media = await syntheticMedia(page, app, app.member, room, "held");
  try {
    await app.open(page, app.member, roomPath(room));
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    // The room's own stage shows the join from its first moment; the
    // background player has no reason to appear, so nothing shifts.
    const stage = page.getByRole("region", { name: room.name, exact: true });
    const player = page.getByRole("region", {
      name: "Current call",
      exact: true,
    });
    await expect(
      stage.getByText("Joining call…", { exact: true }),
    ).toBeVisible();
    await expect(player).toHaveCount(0);
    await expect.poll(() => media.joins.length).toBe(1);
    await stage.getByRole("button", { name: "Leave", exact: true }).click();
    await expect.poll(() => media.leaves.length).toBe(1);
    const leave = media.leaves[0]!;
    expect("pending" in leave && leave.pending).toEqual({
      path: "join",
      body: media.joins[0],
    });
    media.release();
    await expect(stage.getByText("Joining call…", { exact: true })).toHaveCount(
      0,
    );
    await expect(player).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Join call", exact: true }),
    ).toBeEnabled();
    expect(new URL(page.url()).pathname).toBe(roomPath(room));
    expect(media.unexpected).toEqual([]);
    await page.route("**/api/media/status", (route) =>
      route.fulfill({
        json: {
          kind: "media_status",
          generation: 2,
          admission: { kind: "cleanup_pending" },
        },
      }),
    );
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await expect(
      page.getByText(
        "Your previous call is still closing. Try again shortly.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Move call", exact: true }),
    ).toHaveCount(0);
    expect(media.joins).toHaveLength(1);
  } finally {
    media.release();
  }
});

test("a failed join exposes recovery on the same room page and preserves its command identity", async ({
  app,
  page,
}) => {
  const room = await app.room("Recoverable call", "media");
  const media = await syntheticMedia(page, app, app.member, room, "failed");
  await app.open(page, app.member, roomPath(room));
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  const stage = page.getByRole("region", { name: room.name, exact: true });
  const player = page.getByRole("region", {
    name: "Current call",
    exact: true,
  });
  await expect(
    stage.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeVisible();
  await expect(
    stage.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible();
  await expect(
    stage.getByRole("status").filter({
      hasText: "The call connection failed. Reconnect to try again.",
    }),
  ).toBeVisible();
  await expect(player).toHaveCount(0);
  media.mode = "joined";
  await stage.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Picture in picture", exact: true }),
  ).toBeVisible();
  await expect(player).toHaveCount(0);
  expect(media.joins).toHaveLength(2);
  expect(media.joins[1]).toEqual(media.joins[0]);
  expect(new URL(page.url()).pathname).toBe(roomPath(room));
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect.poll(() => media.leaves.length).toBe(1);
  expect(media.unexpected).toEqual([]);
});

test("participant controls tolerate room activity and recover a local target conflict", async ({
  app,
  page,
}) => {
  const room = await app.room("Moderated call", "media");
  const media = await syntheticMedia(page, app, app.owner, room, "joined");
  media.participants = [
    {
      id: "peer",
      userId: app.member.profile.userId,
      generation: 1,
      controlVersion: 0,
      muted: false,
      deafened: false,
      screenRevoked: false,
      status: "active",
      publications: [],
    },
  ];
  await app.open(page, app.owner, roomPath(room));
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  const stage = page.getByRole("region", { name: room.name, exact: true });
  const manage = stage.getByRole("button", {
    name: "Manage Browser Member",
    exact: true,
  });
  await manage.click();
  const menu = page.getByRole("menu", {
    name: "Manage Browser Member",
    exact: true,
  });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Mute",
    "Deafen",
    "Stop screen sharing",
    "Remove from call",
  ]);
  const mute = menu.getByRole("menuitem", { name: "Mute", exact: true });
  await expect(mute).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Deafen", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(mute).toBeFocused();
  media.revision += 7; // Other call activity cannot invalidate the displayed target.
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(manage).toBeFocused();
  await expect.poll(() => media.moderations.length).toBe(1);
  expect(media.moderations[0]).toMatchObject({
    room: { owner: room.owner, channelId: room.channelId },
    userId: app.member.profile.userId,
    action: "mute",
    enabled: true,
    participantGeneration: 1,
    expectedControlVersion: 0,
  });
  await manage.click();
  media.participants[0]!.controlVersion++; // A competing accepted control on this participant.
  await menu
    .getByRole("menuitem", { name: "Allow microphone", exact: true })
    .click();
  await expect(
    page.getByText("This member’s call state changed. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(media.moderations).toHaveLength(2);
  expect(media.moderations[1]).toMatchObject({
    participantGeneration: 1,
    expectedControlVersion: 1,
  });
  expect(media.joins).toHaveLength(1);
  expect(media.resumes).toHaveLength(0);
  expect(media.leaves).toHaveLength(0);
  await manage.click();
  await menu
    .getByRole("menuitem", { name: "Allow microphone", exact: true })
    .click();
  await expect.poll(() => media.moderations.length).toBe(3);
  expect(media.moderations[2]).toMatchObject({
    participantGeneration: 1,
    expectedControlVersion: 2,
  });
  await expect(
    stage.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible();
  expect(media.unexpected).toEqual([]);
});

test("a DM keeps call controls when its stage is folded and when mobile Home hides the conversation", async ({
  app,
  page,
}) => {
  const media = await syntheticMedia(page, app, app.member, app.dm, "joined");
  await app.open(page, app.member, roomPath(app.dm));
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  const player = page.getByRole("region", {
    name: "Current call",
    exact: true,
  });
  const stageToggle = page.getByRole("button", {
    name: "Picture in picture",
    exact: true,
  });
  const summary = page.locator("summary").filter({ hasText: "Call" });
  await expect(stageToggle).toBeVisible();
  await expect(player).toHaveCount(0);
  await expect(page.locator("textarea")).toBeVisible();
  await summary.click();
  await expect(stageToggle).not.toBeVisible();
  await expect(
    player.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await expect(
    player.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible();
  await summary.click();
  await expect(stageToggle).toBeVisible();
  await expect(player).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open conversations", exact: true })
    .click();
  await expect(
    player.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible();
  await expect(stageToggle).not.toBeVisible();
  await player.getByRole("button", { name: "Leave", exact: true }).click();
  await expect.poll(() => media.leaves.length).toBe(1);
  await expect(player).toHaveCount(0);
  expect(media.unexpected).toEqual([]);
});
