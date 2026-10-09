import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  roomPath,
  type Account,
  type BrowserApplication,
} from "@tests/e2e/fixtures";
import {
  chimes,
  countChimes,
  inboxFrames,
  settingsRead,
} from "@tests/e2e/helpers";
import {
  NotificationCommandSchema,
  NotificationOutcomeSchema,
  type NotificationCommand,
} from "@vaskel/contracts/notifications";
import type { Page } from "@playwright/test";

/** Browser permission/subscription is synthetic; actor management and shell are real. */
async function syntheticPush(page: Page) {
  await page.context().grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    });
    Notification.requestPermission = async () => "granted";
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const make = (value: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    }) => ({
      endpoint: value.endpoint,
      toJSON: () => value,
      unsubscribe: async () => {
        localStorage.removeItem("synthetic.push");
        return true;
      },
    });
    PushManager.prototype.getSubscription = async function () {
      const raw = localStorage.getItem("synthetic.push");
      return raw
        ? (make(JSON.parse(raw)) as unknown as PushSubscription)
        : null;
    };
    PushManager.prototype.subscribe = async function () {
      const keys = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
      const value = {
        endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${crypto.randomUUID()}`,
        keys: {
          p256dh: encode(new Uint8Array(raw)),
          auth: encode(crypto.getRandomValues(new Uint8Array(16))),
        },
      };
      localStorage.setItem("synthetic.push", JSON.stringify(value));
      return make(value) as unknown as PushSubscription;
    };
  });
}

test("notification settings enroll, test, pause and remove a browser; room settings persist", async ({
  app,
  page,
}) => {
  await syntheticPush(page);
  await app.open(page, app.owner, "/settings/notifications");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const panel = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  await panel
    .getByLabel("Device name", { exact: true })
    .fill("Synthetic laptop");
  await panel
    .getByRole("button", { name: "Enable on this device", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("list", { name: "Receiving devices" }),
  ).toContainText("Synthetic laptop");
  await panel
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect(
    panel.getByRole("checkbox", {
      name: "Pause push notifications on all devices",
    }),
  ).toBeEnabled();
  await panel
    .getByRole("checkbox", { name: "Pause push notifications on all devices" })
    .click();
  await expect(
    panel.getByRole("checkbox", {
      name: "Pause push notifications on all devices",
    }),
  ).toBeChecked();
  await expect(
    panel.getByLabel("Notification preview", { exact: true }),
  ).toBeEnabled();
  await panel
    .getByLabel("Notification preview", { exact: true })
    .selectOption("message");
  await expect(
    panel.getByLabel("Notification preview", { exact: true }),
  ).toHaveValue("message");
  // Expired/removed authentication cookies must not retire independent enrollment.
  await page.context().clearCookies();
  await app.open(page, app.owner, "/settings/notifications");
  await expect(
    panel.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const bodyWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(bodyWidth).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${app.origin}${roomPath(app.circle)}`);
  await page
    .getByRole("button", { name: "Conversation notifications", exact: true })
    .click();
  await page.getByLabel("Notify me about", { exact: true }).selectOption("all");
  await expect(
    page.getByLabel("Mute this conversation", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Mute this conversation", { exact: true })
    .selectOption("3600000");
  await expect(
    page.getByLabel("Mute this conversation", { exact: true }),
  ).toHaveValue("active");
  await page.goto(`${app.origin}/settings/notifications`);
  await panel
    .getByRole("button", { name: "Turn off on this device", exact: true })
    .click();
  await expect(
    panel.getByText("No devices are receiving notifications.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("synthetic.push")),
  ).toBeNull();
  const state = NotificationOutcomeSchema.parse(
    (await app.request(app.owner, "/api/notifications")).result,
  );
  expect(state.kind).toBe("notification_state");
  if (state.kind !== "notification_state") return;
  expect(state.state.preferences).toMatchObject({
    paused: true,
    preview: "message",
  });
  expect(state.state.rooms[0]).toMatchObject({
    mode: "all",
    roomId: app.circle.channelId,
  });
});

test("another tab observes the same enrollment after subscription creation finishes", async ({
  app,
  page,
}) => {
  await syntheticPush(page);
  await app.open(page, app.owner, "/settings/notifications");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  let finishSubscribe!: () => void;
  await page.exposeFunction(
    "finishSyntheticSubscribe",
    () =>
      new Promise<void>((resolve) => {
        finishSubscribe = resolve;
      }),
  );
  // Push API associates the subscription before queuing subscribe() resolution.
  // Widen that interval in the synthetic provider; native provider timing is not under test.
  await page.evaluate(() => {
    const subscribe = PushManager.prototype.subscribe;
    PushManager.prototype.subscribe = async function (options) {
      const result = await subscribe.call(this, options);
      await (
        window as unknown as { finishSyntheticSubscribe(): Promise<void> }
      ).finishSyntheticSubscribe();
      return result;
    };
  });
  // A lost Enable request leaves the controller's exact pending command available to retry.
  await page.route("**/api/notifications/commands", (route) =>
    route.abort("failed"),
  );
  const panel = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Enable on this device", exact: true })
    .click();
  await expect.poll(() => Boolean(finishSubscribe)).toBe(true);
  const other = await page.context().newPage();
  try {
    await syntheticPush(other);
    await other.goto(`${app.origin}/settings/notifications`);
    const second = other.getByRole("region", {
      name: "Notifications",
      exact: true,
    });
    const orphaned = second.getByText(
      "This browser still holds an old notification subscription. Turn it off, then enable notifications again.",
      { exact: true },
    );
    // Subscription exists, while the first tab still awaits subscribe() before saving its endpoint.
    await expect(orphaned).toBeVisible();
    const deviceBefore = await other.evaluate(
      () =>
        JSON.parse(localStorage.getItem("vaskel.notification-binding")!)
          .deviceId as string,
    );
    finishSubscribe();
    await expect(
      panel.getByRole("button", { name: "Enable on this device", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        other.evaluate(() => {
          const binding = JSON.parse(
            localStorage.getItem("vaskel.notification-binding")!,
          );
          return (
            binding.endpoint !== null && binding.pending?.kind === "enable"
          );
        }),
      )
      .toBe(true);
    expect(
      await other.evaluate(
        () =>
          JSON.parse(localStorage.getItem("vaskel.notification-binding")!)
            .deviceId as string,
      ),
    ).toBe(deviceBefore);
    await expect(orphaned).toHaveCount(0);
    await expect(
      second.getByRole("button", {
        name: "Enable on this device",
        exact: true,
      }),
    ).toBeEnabled();
    await second
      .getByRole("button", { name: "Enable on this device", exact: true })
      .click();
    await expect(
      second.getByRole("button", {
        name: "Send test notification",
        exact: true,
      }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "Turn off on this device", exact: true })
      .click();
    await expect(
      second.getByText("No devices are receiving notifications.", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    finishSubscribe();
    await other.close();
  }
});

test("removing another device restores list focus and preserves this browser", async ({
  app,
  page,
  browser,
}) => {
  await syntheticPush(page);
  await app.open(page, app.owner, "/settings/notifications");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const panel = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  await panel.getByLabel("Device name", { exact: true }).fill("This laptop");
  await panel
    .getByRole("button", { name: "Enable on this device", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeVisible();
  const subscription = await page.evaluate(() =>
    localStorage.getItem("synthetic.push"),
  );
  const remoteContext = await browser.newContext();
  const remote = await remoteContext.newPage();
  try {
    await syntheticPush(remote);
    await app.open(remote, app.owner, "/settings/notifications");
    await remote.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const second = remote.getByRole("region", {
      name: "Notifications",
      exact: true,
    });
    await second
      .getByLabel("Device name", { exact: true })
      .fill("Other browser");
    await second
      .getByRole("button", { name: "Enable on this device", exact: true })
      .click();
    await expect(
      second.getByRole("button", {
        name: "Send test notification",
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await panel
      .getByRole("button", { name: "Remove Other browser", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Remove device", exact: true })
      .click();
    const list = panel.getByRole("list", { name: "Receiving devices" });
    await expect(list).not.toContainText("Other browser");
    await expect(list).toBeFocused();
    await expect(
      panel.getByText("Device removed.", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Send test notification",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("synthetic.push")),
    ).toBe(subscription);
  } finally {
    await remoteContext.close();
  }
});

test("notification preference retry recovers an accepted command without replacing newer settings", async ({
  app,
  page,
}) => {
  await app.open(page, app.owner, "/settings/notifications");
  const panel = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  const pause = panel.getByRole("checkbox", {
    name: "Pause push notifications on all devices",
  });
  const preview = panel.getByLabel("Notification preview", { exact: true });
  const retry = panel.getByRole("button", { name: "Try again", exact: true });
  const commands: NotificationCommand[] = [];
  let acceptedRevision: number | undefined;
  let latestRevision: number | undefined;
  await page.route("**/api/notifications/commands", async (route) => {
    commands.push(
      NotificationCommandSchema.parse(route.request().postDataJSON()),
    );
    if (commands.length !== 1) return route.continue();
    // Commit the request, then lose its response after another device changes settings.
    const accepted = NotificationOutcomeSchema.parse(
      await (await route.fetch()).json(),
    );
    if (accepted.kind !== "notification_updated")
      throw new Error("Expected accepted preference command");
    acceptedRevision = accepted.receipt.revision;
    const newer = NotificationOutcomeSchema.parse(
      (
        await app.request(app.owner, "/api/notifications/commands", {
          commandId: randomUUID(),
          issuedAt: Date.now(),
          expectedRevision: accepted.state.revision,
          kind: "preferences",
          ...accepted.state.preferences,
          paused: false,
          preview: "message",
        })
      ).result,
    );
    if (newer.kind !== "notification_updated")
      throw new Error("Expected newer preference command");
    latestRevision = newer.state.revision;
    await route.abort("connectionreset");
  });
  await pause.click();
  await expect(retry).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect", exact: true }),
  ).toHaveCount(0);
  await expect(pause).toBeEnabled();
  await expect(preview).toHaveValue("message");
  await expect(pause).not.toBeChecked();
  const response = page.waitForResponse("**/api/notifications/commands");
  await retry.click();
  const recovered = NotificationOutcomeSchema.parse(
    await (await response).json(),
  );
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(recovered.kind).toBe("notification_updated");
  if (recovered.kind !== "notification_updated") return;
  expect(recovered.receipt.revision).toBe(acceptedRevision);
  expect(recovered.state.revision).toBe(latestRevision);
  expect(recovered.state.preferences).toMatchObject({
    paused: false,
    preview: "message",
  });
  await expect(pause).not.toBeChecked();
  await expect(preview).toHaveValue("message");
});

test("notification return preserves a different signed-in account and resolves intended-account access", async ({
  app,
  page,
}) => {
  const target = `/notifications/${app.member.profile.userId}/server/${app.circle.owner.id}/${app.circle.channelId}`;
  await app.open(page, app.owner, "/");
  await page.goto(`${app.origin}${target}`);
  await expect(
    page.getByRole("heading", {
      name: "This notification is for another account",
    }),
  ).toBeVisible();
  const me = await page.request.get(`${app.origin}/api/identity/me`);
  expect(
    (await me.json()).profile?.userId ?? (await me.json()).user?.userId,
  ).toBe(app.owner.profile.userId);
  await page.context().clearCookies();
  await app.open(page, app.member, "/");
  await page.goto(`${app.origin}${target}`);
  await expect(page).toHaveURL(`${app.origin}${roomPath(app.circle)}`);
  await expect(
    page.getByRole("heading", { name: app.circle.name, exact: true }),
  ).toBeVisible();
});

test("message sounds play once per browser, stay quiet where you look and follow quiet choices", async ({
  app,
  page,
}) => {
  const context = page.context();
  await countChimes(context);
  const frames = inboxFrames(page);
  const opened = settingsRead(page);
  await app.open(page, app.member, "/settings/notifications");
  await opened;
  const other = await context.newPage();
  const otherFrames = inboxFrames(other);
  // Reloading a tab resets its counter, so earlier sounds are carried over.
  let earlier = 0;
  const heard = async () => earlier + (await chimes(page, other));
  const readyCount = (received: Record<string, unknown>[]) =>
    received.filter((frame) => frame.type === "ready").length;
  const visit = async (
    tab: Page,
    received: Record<string, unknown>[],
    path: string,
  ) => {
    earlier += await chimes(tab);
    const ready = readyCount(received);
    const loaded = settingsRead(tab);
    await tab.goto(`${app.origin}${path}`);
    await loaded;
    await expect.poll(() => readyCount(received)).toBeGreaterThan(ready);
    // Browsers start audio only after a gesture in each tab.
    await tab.mouse.click(4, 4);
  };
  await expect.poll(() => readyCount(frames)).toBeGreaterThan(0);
  await page.mouse.click(4, 4);
  await visit(other, otherFrames, "/settings/notifications");
  const arrived = (sequence: number) =>
    expect
      .poll(() =>
        frames.some(
          (frame) => frame.type === "activity" && frame.sequence === sequence,
        ),
      )
      .toBe(true);
  const afterCooldown = () => page.waitForTimeout(3_500);
  // A change made elsewhere reaches both tabs through a settings hint.
  const changeElsewhere = async (preference: Parameters<typeof room>[2]) => {
    const refreshed = Promise.all([settingsRead(page), settingsRead(other)]);
    await room(app, app.member, preference);
    await refreshed;
  };

  // A DM while both tabs are elsewhere: one sound for the browser, no settings read.
  const settingsReads: string[] = [];
  for (const tab of [page, other])
    tab.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/notifications"))
        settingsReads.push(request.url());
    });
  await app.sendReceipt(app.owner, app.dm, "Are you around?");
  await expect.poll(heard).toBe(1);
  expect(
    frames.some((frame) => frame.type === "activity" && frame.direct === true),
  ).toBe(true);
  expect(settingsReads).toEqual([]);

  // The same conversation on screen in another tab stays quiet.
  await visit(other, otherFrames, roomPath(app.dm));
  await other.bringToFront();
  await expect(
    other.getByText("Are you around?", { exact: true }),
  ).toBeVisible();
  await afterCooldown();
  await arrived(
    (await app.sendReceipt(app.owner, app.dm, "Still here?")).sequence,
  );
  await page.waitForTimeout(500);
  expect(await heard()).toBe(1);

  // An All-messages burst makes one sound.
  await visit(other, otherFrames, "/settings/notifications");
  await changeElsewhere({ mode: "all", mutedUntil: null });
  await afterCooldown();
  for (const body of ["One", "Two", "Three"])
    await app.sendReceipt(app.owner, app.circle, body);
  await expect.poll(heard).toBe(2);
  await page.waitForTimeout(1_000);
  expect(await heard()).toBe(2);

  // A confirmed mute, wherever it was chosen, silences the next message.
  await changeElsewhere({ mode: "all", mutedUntil: Date.now() + 3_600_000 });
  await afterCooldown();
  await arrived(
    (await app.sendReceipt(app.owner, app.circle, "Muted")).sequence,
  );
  await page.waitForTimeout(500);
  expect(await heard()).toBe(2);

  // Turning Message sounds off in one tab silences the others too.
  await page
    .getByRole("switch", {
      name: "Play a sound for new messages while vaskel. is open",
    })
    .click();
  await afterCooldown();
  await arrived((await app.sendReceipt(app.owner, app.dm, "Hello?")).sequence);
  await page.waitForTimeout(500);
  expect(await heard()).toBe(2);
  // Turning it back on previews the sound.
  await page
    .getByRole("switch", {
      name: "Play a sound for new messages while vaskel. is open",
    })
    .click();
  await expect.poll(heard).toBe(3);
});

async function room(
  app: BrowserApplication,
  account: Account,
  preference: { mode: "direct" | "all" | "nothing"; mutedUntil: number | null },
) {
  const state = NotificationOutcomeSchema.parse(
    (await app.request(account, "/api/notifications")).result,
  );
  if (state.kind !== "notification_state") throw new Error(state.kind);
  const changed = NotificationOutcomeSchema.parse(
    (
      await app.request(account, "/api/notifications/commands", {
        commandId: randomUUID(),
        issuedAt: Date.now(),
        expectedRevision: state.state.revision,
        kind: "room",
        owner: app.circle.owner,
        roomId: app.circle.channelId,
        ...preference,
      })
    ).result,
  );
  expect(changed.kind).toBe("notification_updated");
}
