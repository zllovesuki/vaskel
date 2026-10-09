import { test, expect, roomPath } from "@tests/e2e/fixtures";
import { inboxFrames, savedHistory } from "@tests/e2e/helpers";

test("foreground deletion retires offline history while search copies remain until Refresh", async ({
  app,
  page,
  context,
}, testInfo) => {
  const retained = "Unrelated DM cache survives deletion";
  await app.send(app.owner, app.dm, retained);
  const room = await app.room("Cache deletion");
  const removed = await app.send(
    app.owner,
    room,
    "UniqueDeletedNeedle cached before inbox deletion",
  );
  const frames = inboxFrames(page);
  await app.open(page, app.member, roomPath(app.dm));
  try {
    await expect.poll(() => savedHistory(page)).toContain(retained);
  } catch (error) {
    const state = {
      meta: await savedHistory(page, "meta"),
      scopes: await savedHistory(page, "scopes"),
      snapshots: await savedHistory(page),
    };
    await testInfo.attach("native-cache-state.json", {
      body: JSON.stringify(state, null, 2),
      contentType: "application/json",
    });
    console.info(JSON.stringify(state));
    throw error;
  }
  await page
    .getByRole("navigation", { name: "Browser Circle rooms", exact: true })
    .getByRole("link", { name: /^Cache deletion/ })
    .click();
  await expect(page.getByText(removed.body!, { exact: true })).toBeVisible();
  await expect.poll(() => savedHistory(page)).toContain(removed.body!);
  await page
    .getByRole("link", { name: "Search messages", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search phrase", exact: true })
    .fill("UniqueDeletedNeedle");
  await page
    .getByRole("searchbox", { name: "Search phrase", exact: true })
    .press("Enter");
  await expect(page.getByText(removed.body!, { exact: true })).toBeVisible();
  const before = frames.length;
  await app.remove(app.owner, room, removed);
  await expect
    .poll(() => frames.slice(before).some((frame) => frame.type === "mutation"))
    .toBe(true);
  await expect(page.getByText(removed.body!, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await expect(page.getByText(removed.body!, { exact: true })).toHaveCount(0);
  await expect.poll(() => savedHistory(page)).not.toContain(removed.body!);
  expect(await savedHistory(page)).toContain(retained);
  try {
    await page
      .getByRole("button", { name: "Account options", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Display language", exact: true })
      .selectOption("ja");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect
      .poll(() => savedHistory(page, "meta"))
      .toContain('"language":"ja"');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await context.setOffline(true);
    await page.goto(`${app.origin}${roomPath(app.dm)}`);
    await expect(page.getByText(retained, { exact: true })).toBeVisible();
    await expect(page.getByText(removed.body!, { exact: true })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");

    // Current history requires an explicit account epoch. Simulate an
    // unmarked disk record using native IDB; cold entry must reveal neither
    // its private message nor its remembered account language.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const opening = indexedDB.open("vaskel-local");
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const database = opening.result;
            const transaction = database.transaction("meta", "readwrite");
            const store = transaction.objectStore("meta");
            const current = store.get("current");
            current.onsuccess = () => {
              const record = current.result as Record<string, unknown>;
              delete record.accountEpoch;
              store.put(record, "current");
            };
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
            transaction.onabort = () => {
              database.close();
              reject(transaction.error);
            };
          };
        }),
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "No saved messages", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(retained, { exact: true })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  } finally {
    // Restore the shared fixture's effective English language through the API.
    await app.request(app.member, "/api/account/preferences", {
      language: "en",
    });
  }
});
