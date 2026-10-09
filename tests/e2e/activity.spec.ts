import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { deferred, fulfillHeld, inboxFrames } from "@tests/e2e/helpers";

test("a delayed activity response cannot revive mentions cleared by another device", async ({
  app,
  page,
}) => {
  const room = await app.room("Mention ordering");
  const frames = inboxFrames(page);
  await app.open(page, app.member, roomPath(app.circle));
  await expect
    .poll(() => frames.some((frame) => frame.type === "ready"))
    .toBe(true);
  // Establish a positive badge through an authoritative summary before holding
  // its next refresh. New inbox references themselves never predict counts.
  await app.send(
    app.owner,
    room,
    `Hello [](/mentions/${app.member.profile.userId}) one`,
  );
  await expect(
    page.locator(
      `[data-unread][href*="${room.channelId}"] [aria-label*="mention"]`,
    ),
  ).toBeVisible();
  const captured = deferred();
  const release = deferred();
  let held = false;
  let released = false;
  await page.route("**/api/account/activity*", async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    captured.resolve();
    await release.promise;
    await fulfillHeld(route, response);
    released = true;
  });
  try {
    const latest = await app.send(
      app.owner,
      room,
      `Hello [](/mentions/${app.member.profile.userId}) two`,
    );
    await captured.promise;
    await expect(
      page.locator(
        `[data-unread][href*="${room.channelId}"] [aria-label*="mention"]`,
      ),
    ).toBeVisible();
    await app.request(app.member, `${apiPath(room)}/read`, {
      channelId: room.channelId,
      sequence: latest.createdSequence,
    });
    await expect(
      page.locator(`[data-unread][href*="${room.channelId}"]`),
    ).toHaveCount(0);
    release.resolve();
    await expect.poll(() => released).toBe(true);
    await expect(
      page.locator(`[data-unread][href*="${room.channelId}"]`),
    ).toHaveCount(0);
    expect((await app.snapshot(app.member, room)).readSequence).toBe(
      latest.createdSequence,
    );
  } finally {
    release.resolve();
  }
});
