import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { savedHistory, deferred, fulfillHeld } from "@tests/e2e/helpers";

for (const broadcasts of [true, false]) {
  test(`cache eviction preserves a live conversation with broadcasts ${broadcasts ? "delivered" : "missed"}`, async ({
    app,
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const rooms = [];
    for (let index = 0; index < 16; index++)
      rooms.push(await app.room(`Cache room ${index}`));
    const message = await app.send(
      app.owner,
      app.dm,
      `Keep live during eviction ${broadcasts}`,
    );
    if (!broadcasts)
      await page.addInitScript(() => {
        const Native = window.BroadcastChannel;
        window.BroadcastChannel = class extends Native {
          constructor(name: string) {
            super(name);
            if (name === "vaskel-history-invalidations-v1")
              Object.defineProperty(this, "onmessage", { set: () => {} });
          }
        };
      });
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => {
            if (
              (window as Window & { missLiveFrames?: boolean }).missLiveFrames
            )
              event.stopImmediatePropagation();
          });
        }
      };
    });
    await app.open(page, app.member, roomPath(app.dm));
    await expect.poll(() => savedHistory(page)).toContain(message.id);
    const composer = page.getByRole("textbox", { name: /^Message / });
    await composer.fill("Keep this live draft");
    let snapshots = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === `${apiPath(app.dm)}/snapshot`)
        snapshots++;
    });
    const writer = await context.newPage();
    try {
      await writer.goto(`${app.origin}${roomPath(rooms[0]!)}`);
      // Fill history through room navigation; repeated document startup can
      // exhaust account request admission before the deletion observer connects.
      for (const room of rooms) {
        await writer.locator(`a[href="${roomPath(room)}"]`).click();
        await expect.poll(() => savedHistory(writer)).toContain(room.channelId);
      }
      await expect.poll(() => savedHistory(page)).not.toContain(message.id);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(composer).toHaveValue("Keep this live draft");
      await expect(
        page.getByText(message.body!, { exact: true }),
      ).toBeVisible();
      // Let the native IndexedDB focus check finish before observing its HTTP consequence.
      await savedHistory(page, "meta");
      expect(snapshots).toBe(0);
      expect(await savedHistory(page, "drafts")).toContain(
        "Keep this live draft",
      );
      // Hold room events (and, in one case, cache broadcasts) while the writer observes a real deletion.
      // Focus must still detect its durable retirement and hide the old body
      // while the replacement authoritative response is held.
      await page.evaluate(() => {
        (window as Window & { missLiveFrames?: boolean }).missLiveFrames = true;
      });
      await writer.goto(`${app.origin}${roomPath(app.dm)}`);
      await expect(
        writer.getByText(message.body!, { exact: true }),
      ).toBeVisible();
      await expect.poll(() => savedHistory(writer)).toContain(message.body!);
      const gate = deferred();
      await page.route(`**${apiPath(app.dm)}/snapshot`, async (route) => {
        const response = await route.fetch();
        await gate.promise;
        await fulfillHeld(route, response);
      });
      try {
        await app.remove(app.owner, app.dm, message);
        await expect
          .poll(() => savedHistory(writer))
          .not.toContain(message.body!);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          page.getByText(message.body!, { exact: true }),
        ).toHaveCount(0);
        await expect.poll(() => snapshots).toBeGreaterThan(0);
        // A second stale-focus check cancels the held response and must start
        // its replacement even though the owner is already hidden.
        const previous = snapshots;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => snapshots).toBeGreaterThan(previous);
        await expect(composer).toHaveValue("Keep this live draft");
      } finally {
        gate.resolve();
      }
    } finally {
      await writer.close();
    }
  });
}
