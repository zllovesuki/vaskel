import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import type { Page } from "@playwright/test";
import { expect, roomPath } from "@tests/e2e/fixtures";
import {
  digest,
  installedKeys,
  root,
  shellFiles,
  test,
  updateWorker,
} from "@tests/e2e/shell-fixture";
import { offlineShellOptions } from "../../apps/client/tools/pwa";

async function openControlledShell(page: Page, origin: string) {
  // Observe completion of the production owner's initial check without replacing
  // registration or issuing a test-owned update that could race the next trigger.
  await page.addInitScript(() => {
    const update = ServiceWorkerRegistration.prototype.update;
    ServiceWorkerRegistration.prototype.update = async function () {
      const result = await update.call(this);
      document.body.dataset.updateChecked = "true";
      return result;
    };
  });
  await page.goto(origin);
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "A");
  await expect(page.locator("body")).toHaveAttribute(
    "data-update-checked",
    "true",
  );
  await expect(page.getByRole("button", { name: "Update now" })).toBeHidden();
}

test("the installed production shell contains every required dependency and only public bytes", async ({
  app,
  page,
}) => {
  await app.open(page, app.member, roomPath(app.dm));
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  const directory = resolve(root, "apps/client/dist/client");
  const expected = await Promise.all(
    (await shellFiles(directory)).map(async (file) => ({
      path: file === "index.html" ? "/" : `/${file}`,
      digest: digest(await readFile(resolve(directory, file))),
    })),
  );
  const actual = await page.evaluate(async () => {
    const cache = await caches.open("vaskel-precache");
    return Promise.all(
      (await cache.keys()).map(async (key) => {
        const response = await cache.match(key);
        if (!response) throw new Error("Shell entry disappeared");
        const hash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", await response.arrayBuffer()),
        );
        return {
          path: new URL(key.url).pathname,
          digest: btoa(String.fromCharCode(...hash)),
        };
      }),
    );
  });
  expect(actual.some((entry) => entry.path.endsWith(".woff2"))).toBe(false);
  expect(actual.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
    expected.sort((a, b) => a.path.localeCompare(b.path)),
  );
});

test("shell updates wait for open tabs and recover cold offline", async ({
  context,
  page,
  shell: fixture,
}) => {
  const { origin, state, versions } = fixture;
  await page.goto(`${origin}/probe`);
  await context.addCookies([
    { name: "synthetic-session", value: "fixture", url: origin },
  ]);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    await caches.open("unrelated-cache");
  });
  await page.reload();
  const initialKeys = (await installedKeys(page))["vaskel-precache"]!;
  const initialHtml = initialKeys.find((key) => new URL(key).pathname === "/");
  expect(initialHtml).toBeDefined();
  state.version = "b";
  expect(await updateWorker(page)).toBe("installed");
  const second = await context.newPage();
  await second.goto(`${origin}/probe`);
  await page.close();
  expect(
    await second.evaluate(
      async () =>
        (await navigator.serviceWorker.getRegistration())?.waiting?.state,
    ),
  ).toBe("installed");
  expect((await installedKeys(second))["vaskel-precache"]).toEqual(
    expect.arrayContaining(initialKeys),
  );
  expect(
    await second.evaluate(() => fetch("/").then((response) => response.text())),
  ).toContain("Shell A");
  await second.close();
  const current = await context.newPage();
  await current.goto(`${origin}/probe`);
  await expect
    .poll(async () => (await installedKeys(current))["vaskel-precache"])
    .not.toContain(initialHtml);
  await current.reload();
  expect(
    await current.evaluate(() =>
      fetch("/").then((response) => response.text()),
    ),
  ).toContain("Shell B");
  expect(await installedKeys(current)).toHaveProperty("unrelated-cache");
  const installed = await installedKeys(current);

  const requestsBefore = state.requests.length;
  const asset = fixture.faultPath;
  await current.evaluate(
    async ({ asset, origin }) => {
      for (const url of [
        "/api/missing",
        "/files/private/content",
        "/src/sw.ts",
        "/?token=x",
        `${asset}?utm_source=x`,
        `${origin.replace("127.0.0.1", "localhost")}${asset}`,
      ])
        await fetch(url);
      await fetch(asset, { method: "POST", body: "synthetic command" });
    },
    { asset, origin },
  );
  expect(state.requests.length - requestsBefore).toBe(7);
  expect(await installedKeys(current)).toEqual(installed);
  expect(
    state.requests
      .slice(0, requestsBefore)
      .filter((request) => request.path.startsWith("/assets/"))
      .every((request) => request.cookie === undefined),
  ).toBe(true);
  const unknown = await current.goto(`${origin}/not-an-application-route`);
  expect(unknown?.status()).toBe(404);
  expect(unknown?.fromServiceWorker()).toBe(false);
  await current.goto(`${origin}/probe`);

  // C changes only the source _headers file, using the real build transform.
  expect(
    await readFile(resolve(versions.b!.directory, "index.html"), "utf8"),
  ).toBe(await readFile(resolve(versions.c!.directory, "index.html"), "utf8"));
  state.version = "c";
  expect(await updateWorker(current)).toBe("installed");
  expect(
    await current.evaluate(() =>
      fetch("/").then((response) => response.headers.get("X-Fixture-Policy")),
    ),
  ).toBe("old");
  await current.close();
  const cold = await context.newPage();
  await cold.goto(`${origin}/probe`);
  await expect
    .poll(() =>
      cold.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.waiting === null,
      ),
    )
    .toBe(true);
  await cold.reload();
  expect(
    await cold.evaluate(() =>
      fetch("/").then((response) => response.headers.get("X-Fixture-Policy")),
    ),
  ).toBe("new");
  const keys = (await installedKeys(cold))["vaskel-precache"]!;
  expect(keys.filter((key) => new URL(key).pathname === "/")).toHaveLength(1);

  // Native eviction: known public entries may be repaired from the network.
  await cold.evaluate(async (asset) => {
    const cache = await caches.open("vaskel-precache");
    for (const key of await cache.keys()) {
      if (
        new URL(key.url).pathname === "/" ||
        new URL(key.url).pathname === asset
      )
        await cache.delete(key);
    }
    await fetch(asset);
  }, asset);
  await cold.goto(`${origin}/`);
  await expect(cold.locator("body")).toHaveAttribute("data-loaded", "B");
  await expect
    .poll(async () => (await installedKeys(cold))["vaskel-precache"]?.length)
    .toBe(versions.c!.files.length);
  const cdp = await context.newCDPSession(cold);
  await cdp.send("Network.clearBrowserCache");
  await fixture.stop();
  const offline = await cold.goto(`${origin}/conversations/synthetic-room`);
  expect(offline?.fromServiceWorker()).toBe(true);
  await expect(cold.getByRole("heading", { name: "Shell B" })).toBeVisible();
  await expect(cold.locator("body")).toHaveAttribute("data-loaded", "B");
});

test("the production update action activates new bytes in both tabs, preserves URLs and opens cold offline", async ({
  context,
  page,
  shell: fixture,
}) => {
  const { origin, state } = fixture;
  const action = page.getByRole("button", { name: "Update now" });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(origin);
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "A");
  await expect(action).toBeHidden();
  expect(navigations).toBe(1);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller),
  ).toBeNull();

  const destination = `${origin}/conversations/synthetic-room#message`;
  await page.goto(destination);
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "A");
  expect(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
  ).toBe(true);
  const second = await context.newPage();
  const secondDestination = `${origin}/conversations/another-room#draft`;
  await second.goto(secondDestination);
  await expect(second.locator("body")).toHaveAttribute("data-loaded", "A");
  await page.evaluate(async () => {
    await caches.open("unrelated-cache");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("authored-work", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put("Saved draft", "current");
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onabort = () => reject(transaction.error);
      };
    });
  });
  state.version = "b";
  expect(await updateWorker(page)).toBe("installed");
  await expect(action).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Update now" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shell A" })).toBeVisible();
  await expect(second.getByRole("heading", { name: "Shell A" })).toBeVisible();
  expect(navigations).toBe(2);

  // Reopening one tab observes the native waiting worker while the other holds A.
  await second.close();
  const reopened = await context.newPage();
  await reopened.goto(secondDestination);
  await expect(reopened.locator("body")).toHaveAttribute("data-loaded", "A");
  await expect(
    reopened.getByRole("button", { name: "Update now" }),
  ).toBeVisible();
  await action.click();
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "B");
  await expect(reopened.locator("body")).toHaveAttribute("data-loaded", "B");
  await expect(page).toHaveURL(destination);
  await expect(reopened).toHaveURL(secondDestination);
  await expect(action).toBeHidden();
  expect(navigations).toBe(3);
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.waiting,
    ),
  ).toBeNull();

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await page.close();
  await reopened.close();
  await fixture.stop();
  const cold = await context.newPage();
  const response = await cold.goto(`${origin}/conversations/cold-room`);
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(cold.getByRole("heading", { name: "Shell B" })).toBeVisible();
  await expect(cold.locator("body")).toHaveAttribute("data-loaded", "B");
  await expect(cold.getByRole("button", { name: "Update now" })).toBeHidden();
  expect(await installedKeys(cold)).toHaveProperty("unrelated-cache");
  expect(
    await cold.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("authored-work");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const read = database
              .transaction("drafts")
              .objectStore("drafts")
              .get("current");
            read.onsuccess = () => {
              database.close();
              resolve(read.result);
            };
            read.onerror = () => reject(read.error);
          };
        }),
    ),
  ).toBe("Saved draft");
});

test("production visible discovery installs an update without reloading", async ({
  page,
  shell: fixture,
}) => {
  await openControlledShell(page, fixture.origin);
  fixture.state.version = "b";
  // Registration, update(), installation and the update subscription all run
  // through the production module; unit coverage owns the trigger matrix.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByRole("button", { name: "Update now" })).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (await navigator.serviceWorker.getRegistration())?.waiting?.state,
    ),
  ).toBe("installed");
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "A");
  await expect(page.getByRole("heading", { name: "Shell A" })).toBeVisible();
});

for (const fault of ["missing", "corrupt", "mime", "quota"] as const) {
  test(`a ${fault} installation preserves the old shell without offering an update`, async ({
    page,
    shell: fixture,
  }) => {
    await openControlledShell(page, fixture.origin);
    const initialKeys = (await installedKeys(page))["vaskel-precache"]!;
    fixture.state.version = "b";
    fixture.state.fault = fault;
    expect(await updateWorker(page)).toBe("redundant");
    expect(
      await page.evaluate(() => fetch("/").then((response) => response.text())),
    ).toContain("Shell A");
    expect((await installedKeys(page))["vaskel-precache"]).toEqual(
      expect.arrayContaining(initialKeys),
    );
    await expect(page.getByRole("button", { name: "Update now" })).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-loaded", "A");
    expect(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistration())?.waiting,
      ),
    ).toBeNull();
    fixture.state.fault = "";
    expect(await updateWorker(page)).toBe("installed");
    await expect(
      page.getByRole("button", { name: "Update now" }),
    ).toBeVisible();
  });
}

test("source development registers no worker and injects no automatic registration", async ({
  page,
}) => {
  const parent = resolve(root, ".local/browser-runs");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "shell-dev-"));
  const server = await createServer({
    configFile: false,
    root: directory,
    logLevel: "silent",
    resolve: { alias: { "@/client": resolve(root, "apps/client/src") } },
    plugins: [VitePWA(offlineShellOptions(resolve(directory, "dist")))],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  try {
    await writeFile(
      resolve(directory, "index.html"),
      '<!doctype html><script type="module">import { registerOfflineShell } from "@/client/shell/register"; registerOfflineShell(); document.title = "Source ready";</script>',
    );
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing development port");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page).toHaveTitle("Source ready");
    expect(
      await page.evaluate(() =>
        navigator.serviceWorker
          .getRegistrations()
          .then((entries) => entries.length),
      ),
    ).toBe(0);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBe(
      null,
    );
    await expect(page.locator('script[src*="registerSW"]')).toHaveCount(0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
