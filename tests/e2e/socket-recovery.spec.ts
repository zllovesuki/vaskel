import { apiErrorResponse } from "@tests/e2e/helpers";
import type { WebSocketRoute } from "@playwright/test";
import { ServerEventSchema } from "@vaskel/contracts/messaging";
import { test, expect, apiPath, roomPath } from "@tests/e2e/fixtures";

test("room authorization renews on one socket while replay repairs a lost final event", async ({
  app,
  page,
}) => {
  test.setTimeout(90_000);
  const room = await app.room("Renewed socket");
  let sockets = 0;
  let tickets = 0;
  let renewals = 0;
  let replays = 0;
  let pongs = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `${apiPath(room)}/socket-ticket`) tickets++;
    if (path === `${apiPath(room)}/socket-renew`) renewals++;
    if (path === `${apiPath(room)}/replay`) replays++;
  });
  await page.routeWebSocket(`**${apiPath(room)}/socket`, (socket) => {
    sockets++;
    const server = socket.connectToServer();
    server.onMessage((data) => {
      const frame = ServerEventSchema.parse(JSON.parse(String(data)));
      if (frame.type === "committed") return;
      if (frame.type === "pong") pongs++;
      socket.send(data);
    });
  });
  // Both transports stay healthy while every non-readiness inbox hint is lost.
  await page.routeWebSocket("**/api/account/events", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { type: string };
      if (frame.type === "ready" || frame.type === "pong") socket.send(data);
    });
  });
  await app.open(page, app.member, roomPath(room));
  await expect.poll(() => replays).toBe(1);
  const message = await app.send(app.owner, room, "Final frame was lost");
  await expect(page.getByText(message.body!, { exact: true })).toHaveCount(0);
  await expect.poll(() => renewals, { timeout: 35_000 }).toBe(1);
  expect(sockets).toBe(1);
  expect(tickets).toBe(1);
  expect(replays).toBe(1);
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible({
    timeout: 35_000,
  });
  expect(renewals).toBeGreaterThanOrEqual(2);
  expect(pongs).toBeGreaterThanOrEqual(2);
  expect(sockets).toBe(1);
  expect(tickets).toBe(1);
  expect(replays).toBe(2);
});

test("room transport retries ticket refusal and reconnects with a fresh single-use subprotocol", async ({
  app,
  page,
}) => {
  const room = await app.room("Socket recovery");
  const sockets: WebSocketRoute[] = [];
  let ready = 0;
  let refuse = false;
  let refused = 0;
  await page.route(`**${apiPath(room)}/socket-ticket`, async (route) => {
    if (!refuse) return route.continue();
    refuse = false;
    refused++;
    await route.fulfill(apiErrorResponse("CAPACITY", { kind: "capacity" }));
  });
  await page.routeWebSocket(`**${apiPath(room)}/socket`, (socket) => {
    sockets.push(socket);
    const server = socket.connectToServer();
    server.onMessage((data) => {
      if (String(data).includes('"type":"ready"')) ready++;
      socket.send(data);
    });
  });
  await app.open(page, app.member, roomPath(room));
  await expect.poll(() => ready).toBe(1);
  const first = sockets[0]!;
  expect(first.protocols()[0]).toBe("vaskel-v1");
  expect(first.protocols()[1]).toMatch(/^vaskel-ticket\./);
  refuse = true;
  await first.close();
  await expect.poll(() => refused).toBe(1);
  await expect.poll(() => ready).toBe(2);
  expect(sockets).toHaveLength(2);
  expect(sockets[1]!.protocols()[0]).toBe("vaskel-v1");
  expect(sockets[1]!.protocols()[1]).not.toBe(first.protocols()[1]);
  expect(sockets[1]!.url()).not.toContain("ticket");
  const message = await app.send(
    app.owner,
    room,
    "Delivered after socket recovery",
  );
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
});

test("a built workspace mounts and receives a real room WebSocket event", async ({
  app,
  page,
}) => {
  const room = await app.room("Live messages");
  const frames: string[] = [];
  page.on("websocket", (socket) => {
    if (socket.url().includes("/resources/"))
      socket.on("framereceived", ({ payload }) => frames.push(String(payload)));
  });
  await app.open(page, app.member, roomPath(room));
  await expect
    .poll(() => frames.some((frame) => frame.includes('"type":"ready"')))
    .toBe(true);
  const message = await app.send(
    app.owner,
    room,
    "Browser live socket message",
  );
  await expect(page.getByText(message.body!, { exact: true })).toBeVisible();
  await expect
    .poll(() => frames.some((frame) => frame.includes(message.id)))
    .toBe(true);
});
