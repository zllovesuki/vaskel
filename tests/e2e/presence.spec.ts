import type { WebSocketRoute } from "@playwright/test";
import {
  ACCOUNT_EVENTS_PING,
  ACCOUNT_EVENTS_PONG,
} from "@vaskel/contracts/account-events";
import { deferred } from "@tests/e2e/helpers";
import {
  PresenceOutcomeSchema,
  PresenceRequestSchema,
} from "@vaskel/contracts/presence";
import { test, expect, roomPath } from "@tests/e2e/fixtures";

test("partial and unavailable presence preserve People without claiming a complete online count", async ({
  app,
  page,
}) => {
  let mode: "partial" | "unavailable" | "complete" = "partial";
  let reads = 0;
  await page.route("**/api/account/presence", async (route) => {
    reads++;
    const request = PresenceRequestSchema.parse(route.request().postDataJSON());
    await route.fulfill({
      json: PresenceOutcomeSchema.parse({
        kind: "presence",
        scopes: request.scopes.map(({ owner }) =>
          mode === "unavailable"
            ? { kind: "unavailable", owner }
            : {
                kind: "sampled",
                owner,
                nextCursor: null,
                samples: [
                  {
                    userId: app.member.profile.userId,
                    state: "online",
                    sampledAt: Date.now(),
                  },
                  mode === "partial"
                    ? { userId: app.owner.profile.userId, state: "unknown" }
                    : {
                        userId: app.owner.profile.userId,
                        state: "offline",
                        sampledAt: Date.now(),
                      },
                ],
              },
        ),
      }),
    });
  });
  await app.open(page, app.member, `/servers/${app.circle.owner.id}/people`);
  const people = page.getByRole("region", { name: "People", exact: true });
  await expect(
    people
      .locator("header")
      .getByText("Presence unavailable", { exact: false }),
  ).toBeVisible();
  await expect(people.getByText("Browser Host", { exact: true })).toBeVisible();
  await expect(
    people.getByText("Browser Member", { exact: true }),
  ).toBeVisible();
  await expect(people.getByText(/\d+ online/)).toHaveCount(0);
  await expect(page.getByText("Only you online", { exact: true })).toHaveCount(
    0,
  );
  mode = "unavailable";
  const beforeFailure = reads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBeGreaterThan(beforeFailure);
  await expect(
    people
      .locator("header")
      .getByText("Presence unavailable", { exact: false }),
  ).toBeVisible();
  await expect(
    people.getByRole("button", { name: "Message", exact: true }),
  ).toBeEnabled();
  mode = "complete";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(people.getByText(/2 people · 1 online/)).toBeVisible();
  await expect(
    people
      .locator("header")
      .getByText("Presence unavailable", { exact: false }),
  ).toHaveCount(0);
});

for (const outcome of ["replacement", "signed-out"] as const) {
  test(`revoked account events wait for identity before ${outcome} recovery`, async ({
    app,
    page,
  }) => {
    const sockets: WebSocketRoute[] = [];
    let tickets = 0;
    await page.routeWebSocket("**/api/account/events", (socket) => {
      sockets.push(socket);
      socket.onMessage((frame) => {
        if (frame === ACCOUNT_EVENTS_PING) socket.send(ACCOUNT_EVENTS_PONG);
      });
      socket.send(
        JSON.stringify({
          type: "ready",
          leaseExpiresAt: Date.now() + 900_000,
          resync: true,
        }),
      );
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/account/events/ticket")
        tickets++;
    });
    await app.open(page, app.member, roomPath(app.circle));
    await expect.poll(() => sockets.length).toBe(1);
    const composer = page.locator("#composer-input");
    await composer.fill("Preserved across a valid replacement cookie");
    if (outcome === "replacement") {
      const replacement = await app.signIn(app.member.email);
      await page.context().addCookies(
        replacement.cookie.split("; ").map((cookie) => {
          const equals = cookie.indexOf("=");
          return {
            name: cookie.slice(0, equals),
            value: cookie.slice(equals + 1),
            url: app.origin,
          };
        }),
      );
    } else await page.context().clearCookies();
    const started = deferred();
    const release = deferred();
    await page.route("**/api/identity/me", async (route) => {
      started.resolve();
      await release.promise;
      await route.continue();
    });
    try {
      sockets[0]!.send(JSON.stringify({ type: "revoked" }));
      await started.promise;
      expect(tickets).toBe(1);
      expect(sockets).toHaveLength(1);
      release.resolve();
      if (outcome === "replacement") {
        await expect.poll(() => sockets.length).toBe(2);
        await expect(composer).toHaveValue(
          "Preserved across a valid replacement cookie",
        );
        await expect(
          page.getByRole("button", { name: "Send", exact: true }),
        ).toBeEnabled();
      } else {
        await expect(
          page.getByRole("textbox", { name: "Email", exact: true }),
        ).toBeVisible();
        expect(tickets).toBe(1);
        expect(sockets).toHaveLength(1);
      }
    } finally {
      release.resolve();
    }
  });
}
