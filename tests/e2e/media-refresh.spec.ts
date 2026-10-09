import type { WebSocketRoute } from "@playwright/test";
import {
  AccountEventFrameSchema,
  ACCOUNT_EVENTS_PING,
  ACCOUNT_EVENTS_PONG,
} from "@vaskel/contracts/account-events";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { syntheticMedia } from "@tests/e2e/media-ui-fixture";

for (const failure of ["metadata", "snapshot"] as const) {
  test(`a failed ${failure} read stays local while the active call keeps its peers`, async ({
    app,
    page,
  }) => {
    const room = await app.room(`Call during ${failure} failure`, "media");
    const media = await syntheticMedia(page, app, app.member, room, "joined");
    let inbox: WebSocketRoute | undefined;
    await page.routeWebSocket("**/api/account/events", (socket) => {
      inbox = socket;
      socket.onMessage((frame) => {
        if (frame === ACCOUNT_EVENTS_PING) socket.send(ACCOUNT_EVENTS_PONG);
      });
      socket.send(
        JSON.stringify(
          AccountEventFrameSchema.parse({
            type: "ready",
            leaseExpiresAt: Date.now() + 900_000,
            resync: true,
          }),
        ),
      );
    });
    await app.open(page, app.member, roomPath(room));
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.uiMediaReceiver?.connectionState))
      .toBe("connected");
    // Observe actual local disposal, including the client's peers, without
    // changing native connection behavior or relying only on retained controls.
    const peers = await page.evaluateHandle(() => {
      const close = RTCPeerConnection.prototype.close;
      const state = {
        closed: 0,
        restore: () => {
          RTCPeerConnection.prototype.close = close;
        },
      };
      RTCPeerConnection.prototype.close = function () {
        state.closed++;
        close.call(this);
      };
      return state;
    });
    const failedPath = `**${apiPath(app.dm)}${failure === "snapshot" ? "/snapshot" : ""}`;
    let failures = 0;
    await page.route(failedPath, async (route) => {
      failures++;
      await route.abort("failed");
    });
    try {
      await page
        .locator(`a[href="${roomPath(app.dm)}"]`)
        .first()
        .click();
      await expect.poll(() => failures).toBeGreaterThan(0);
      const retry = page.getByRole("button", {
        name: "Try again",
        exact: true,
      });
      await expect(retry).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Leave", exact: true }),
      ).toBeVisible();
      const before = media.heartbeats;
      if (!inbox) throw new Error("Account events did not connect");
      inbox.send(
        JSON.stringify(
          AccountEventFrameSchema.parse({
            type: "call",
            owner: room.owner,
            channelId: room.channelId,
          }),
        ),
      );
      await expect.poll(() => media.heartbeats).toBeGreaterThan(before);
      expect(await peers.evaluate((state) => state.closed)).toBe(0);
      expect(media.joins).toHaveLength(1);
      expect(media.resumes).toHaveLength(0);
      expect(media.leaves).toHaveLength(0);
      await page.unroute(failedPath);
      await retry.click();
      await expect(page.locator("#composer-input")).toBeVisible();
      expect(await peers.evaluate((state) => state.closed)).toBe(0);
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await expect.poll(() => media.leaves.length).toBe(1);
      await expect
        .poll(() => peers.evaluate((state) => state.closed))
        .toBeGreaterThan(0);
      expect(media.unexpected).toEqual([]);
    } finally {
      await peers.evaluate((state) => state.restore());
      await peers.dispose();
    }
  });
}

test("call hints and inbox reconnect refresh participation without leaving or rejoining", async ({
  app,
  page,
}) => {
  const room = await app.room("Call notices", "media");
  const media = await syntheticMedia(page, app, app.member, room, "joined");
  const sockets: WebSocketRoute[] = [];
  const ready = (socket: WebSocketRoute) =>
    socket.send(
      JSON.stringify(
        AccountEventFrameSchema.parse({
          type: "ready",
          leaseExpiresAt: Date.now() + 900_000,
          resync: true,
        }),
      ),
    );
  await page.routeWebSocket("**/api/account/events", (socket) => {
    sockets.push(socket);
    socket.onMessage((frame) => {
      if (frame === ACCOUNT_EVENTS_PING) socket.send(ACCOUNT_EVENTS_PONG);
    });
    if (sockets.length === 1) ready(socket);
  });
  await app.open(page, app.member, roomPath(room));
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Picture in picture", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.uiMediaReceiver)))
    .toBe(true);
  const receiver = await page.evaluateHandle(() => window.uiMediaReceiver);
  const handles: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/heartbeat"))
      handles.push(request.postDataJSON());
  });
  const snapshots = media.snapshots;
  media.participants = [
    {
      id: "peer",
      userId: app.owner.profile.userId,
      generation: 1,
      controlVersion: 0,
      muted: false,
      deafened: false,
      screenRevoked: false,
      status: "active",
      publications: [],
    },
  ];
  media.revision++;
  sockets[0]!.send(
    JSON.stringify(
      AccountEventFrameSchema.parse({
        type: "call",
        owner: room.owner,
        channelId: room.channelId,
      }),
    ),
  );
  const peer = page
    .getByRole("region", { name: room.name, exact: true })
    .getByText(app.owner.profile.displayName, { exact: true });
  await expect(peer).toBeVisible();
  expect(media.heartbeats).toBeGreaterThan(0);
  expect(media.snapshots).toBe(snapshots);
  await sockets[0]!.close({ code: 1012, reason: "Synthetic actor restart" });
  await expect.poll(() => sockets.length).toBe(2);
  // Withhold ready: the notification outage itself must not clear the stage.
  await expect(peer).toBeVisible();
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  const beats = media.heartbeats;
  ready(sockets[1]!);
  await expect.poll(() => media.heartbeats).toBeGreaterThan(beats);
  await expect(peer).toBeVisible();
  expect(
    await page.evaluate(
      (original) =>
        window.uiMediaReceiver === original &&
        original?.connectionState !== "closed",
      receiver,
    ),
  ).toBe(true);
  expect(handles.length).toBeGreaterThan(0);
  expect(
    handles.every(
      (handle) => JSON.stringify(handle) === JSON.stringify(handles[0]),
    ),
  ).toBe(true);
  await receiver.dispose();
  media.participants = [];
  media.revision++;
  sockets[1]!.send(
    JSON.stringify({
      type: "call",
      owner: room.owner,
      channelId: room.channelId,
    }),
  );
  await expect(peer).toHaveCount(0);
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect.poll(() => media.leaves.length).toBe(1);
  expect(media.unexpected).toEqual([]);
});

test("synthetic hidden visibility defers directory hints while call refresh continues", async ({
  app,
  page,
}) => {
  const room = await app.room("Background call", "media");
  const media = await syntheticMedia(page, app, app.member, room, "joined");
  let inbox: WebSocketRoute | undefined;
  let directoryRequests = 0;
  const pendingDirectory = new Set<string>();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/directory") {
      directoryRequests++;
      pendingDirectory.add(request.url());
    }
  });
  page.on("requestfinished", (request) =>
    pendingDirectory.delete(request.url()),
  );
  page.on("requestfailed", (request) => pendingDirectory.delete(request.url()));
  await page.routeWebSocket("**/api/account/events", (socket) => {
    inbox = socket;
    socket.onMessage((frame) => {
      if (frame === ACCOUNT_EVENTS_PING) socket.send(ACCOUNT_EVENTS_PONG);
    });
    socket.send(
      JSON.stringify(
        AccountEventFrameSchema.parse({
          type: "ready",
          leaseExpiresAt: Date.now() + 900_000,
          resync: true,
        }),
      ),
    );
  });
  await app.open(page, app.member, roomPath(room));
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Picture in picture", exact: true }),
  ).toBeVisible();
  await expect.poll(() => pendingDirectory.size).toBe(0);
  const before = directoryRequests;
  const heartbeats = media.heartbeats;
  // Control only the visibility signal; this does not simulate browser throttling.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  if (!inbox) throw new Error("Inbox did not connect");
  for (let hint = 0; hint < 3; hint++)
    inbox.send(
      JSON.stringify(
        AccountEventFrameSchema.parse({
          type: "occupancy",
          owner: room.owner,
          channelId: room.channelId,
        }),
      ),
    );
  await expect.poll(() => media.heartbeats).toBeGreaterThan(heartbeats);
  await page.waitForTimeout(2_100);
  expect(directoryRequests).toBe(before);
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => directoryRequests).toBeGreaterThan(before);
  await expect(
    page.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible();
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  expect(media.unexpected).toEqual([]);
});

test("optional account event and presence outages preserve an active call and text commands", async ({
  app,
  page,
}) => {
  const room = await app.room("Optional metadata outage", "media");
  const media = await syntheticMedia(page, app, app.member, room, "joined");
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/account/events", (connection) => {
    socket = connection;
    connection.onMessage((frame) => {
      if (frame === ACCOUNT_EVENTS_PING) connection.send(ACCOUNT_EVENTS_PONG);
    });
    connection.send(
      JSON.stringify(
        AccountEventFrameSchema.parse({
          type: "ready",
          leaseExpiresAt: Date.now() + 900_000,
          resync: true,
        }),
      ),
    );
  });
  await app.open(page, app.member, roomPath(room));
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Picture in picture", exact: true }),
  ).toBeVisible();
  await page
    .locator(`a[href="${roomPath(app.circle)}"]`)
    .first()
    .click();
  const composer = page.locator("#composer-input");
  await composer.fill("A draft survives optional metadata failure");
  let failures = 0;
  await page.route("**/api/account/events/ticket", async (route) => {
    failures++;
    await route.abort("failed");
  });
  await page.route("**/api/account/presence", async (route) => {
    failures++;
    await route.abort("failed");
  });
  const heartbeats = media.heartbeats;
  if (!socket) throw new Error("Account events did not connect");
  await socket.close({ code: 1012, reason: "Synthetic hub unavailable" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
  await expect(composer).toHaveValue(
    "A draft survives optional metadata failure",
  );
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(
    page.getByText("A draft survives optional metadata failure", {
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => media.heartbeats, { timeout: 15_000 })
    .toBeGreaterThan(heartbeats);
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Leave", exact: true }),
  ).toBeVisible();
  expect(media.unexpected).toEqual([]);
});
