import { deferred } from "@tests/shared/deferred";
import {
  MessagingOutcomeSchema,
  ServerEventSchema,
} from "@vaskel/contracts/messaging";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { apiErrorResponse, savedHistory } from "@tests/e2e/helpers";

const file = {
  name: "receipt-proof.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("durable acceptance proof"),
};

for (const replayOutcome of ["success", "capacity", "history"] as const) {
  test(`accepted Send completes before held replay: ${replayOutcome}`, async ({
    app,
    page,
  }) => {
    const room = await app.room(`Receipt replay ${replayOutcome}`);
    const text = `Accepted before replay ${replayOutcome}`;
    const historical =
      replayOutcome === "history"
        ? await app.send(app.owner, room, "Keep this historical position")
        : null;
    let sendRequests = 0;
    let cancelRequests = 0;
    let droppedFrames = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === `${apiPath(room)}/send`) sendRequests++;
      if (path.endsWith("/cancel")) cancelRequests++;
    });
    await page.routeWebSocket(`**${apiPath(room)}/socket`, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((data) => {
        const frame = ServerEventSchema.parse(JSON.parse(String(data)));
        if (frame.type === "committed") {
          droppedFrames++;
          return;
        }
        socket.send(data);
      });
    });
    await page.routeWebSocket("**/api/account/events", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((data) => {
        const frame = JSON.parse(String(data)) as { type: string };
        if (frame.type === "ready" || frame.type === "pong") socket.send(data);
      });
    });
    const openingReplay = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${apiPath(room)}/replay`,
    );
    await app.open(
      page,
      app.member,
      historical
        ? `${roomPath(room)}?at=${historical.createdSequence}`
        : roomPath(room),
    );
    if (historical)
      await expect(
        page.getByText(historical.body!, { exact: true }),
      ).toBeVisible();
    await openingReplay;
    const composer = page.getByRole("textbox", { name: /^Message / });
    await composer.fill(text);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles(file);
    await expect(page.getByText("Ready", { exact: false })).toBeVisible();

    const { promise: gate, resolve: release } = deferred();
    let entered = false;
    await page.route(`**${apiPath(room)}/replay`, async (route) => {
      entered = true;
      await gate;
      if (replayOutcome === "capacity")
        await route.fulfill(apiErrorResponse("CAPACITY", { kind: "capacity" }));
      else await route.continue();
    });
    try {
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `${apiPath(room)}/send`,
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const receipt = MessagingOutcomeSchema.parse(
        await (await response).json(),
      );
      expect(receipt.kind).toBe("accepted");
      await expect.poll(() => entered).toBe(true);
      await expect.poll(() => droppedFrames).toBe(1);
      const authoritative = await app.snapshot(app.member, room);
      const accepted = authoritative.messages.find((row) => row.body === text)!;
      expect(accepted).toMatchObject({
        body: text,
        attachments: [{ filename: file.name }],
      });
      await expect(composer).toHaveValue("");
      await expect(composer).toBeEditable();
      await expect(page.getByRole("button", { name: /Sending/ })).toHaveCount(
        0,
      );
      await expect.poll(() => savedHistory(page, "drafts")).not.toContain(text);
      await expect.poll(() => savedHistory(page, "draftFiles")).toBe("[]");
      const sequence = accepted.createdSequence;
      await expect(
        page.locator(`[data-timeline-sequence="${sequence}"]`),
      ).toHaveCount(0);
      if (historical) expect(authoritative.readSequence).toBe(0);

      const replayed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `${apiPath(room)}/replay`,
      );
      release();
      await (await replayed).finished();
      await expect(composer).toHaveValue("");
      await expect.poll(() => savedHistory(page, "drafts")).not.toContain(text);
      await expect.poll(() => savedHistory(page, "draftFiles")).toBe("[]");
      if (replayOutcome === "success")
        await expect(
          page.locator(`[data-timeline-sequence="${sequence}"]`),
        ).toHaveCount(1);
      else
        await expect(
          page.locator(`[data-timeline-sequence="${sequence}"]`),
        ).toHaveCount(0);
      expect(sendRequests).toBe(1);
      expect(cancelRequests).toBe(0);
      if (historical) {
        expect((await app.snapshot(app.member, room)).readSequence).toBe(0);
        await expect(
          page.getByText(historical.body!, { exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: /Jump to latest|Newer messages below/ })
          .click();
        await expect(
          page.locator(`[data-timeline-sequence="${sequence}"]`),
        ).toHaveCount(1);
      }
    } finally {
      release();
    }
  });
}
