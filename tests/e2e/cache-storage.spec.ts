import { expect } from "@playwright/test";
import type { CacheResult } from "@/client/features/cache/model";
import { browserModuleTest } from "@tests/e2e/browser-module";

const test = browserModuleTest({
  entry: "apps/client/src/features/cache/storage/index.ts",
  filename: "storage.js",
  html: "<!doctype html><title>Native storage proof</title>",
});
type Storage = typeof import("@/client/features/cache/storage");
const modulePath = "/storage.js";

test("draft file rollback, history clearing and owner retirement keep distinct lifetimes", async ({
  page,
  moduleOrigin: origin,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async (path) => {
    const { historyCache: cache, draftStorage: drafts } = (await import(
      path
    )) as Storage;
    function value<T>(result: CacheResult<T>): T {
      if (result.kind !== "ok") throw new Error(JSON.stringify(result));
      return result.value;
    }
    const account = value(
      await cache.activateAccount(value(await cache.captureAccount()), {
        accountId: "account",
        label: "Account",
      }),
    );
    const target = {
      owner: { kind: "conversation" as const, id: "owner" },
      channelId: "channel",
      label: "Room",
    };
    const generation = crypto.randomUUID();
    const historyFence = value(
      await cache.authorizeScope(
        value(await cache.captureScope(account, target.owner)),
        generation,
      ),
    );
    value(
      await cache.save(
        historyFence,
        {
          cursor: {
            owner: target.owner,
            channelId: target.channelId,
            generation,
            sequence: 0,
          },
          messages: [],
          nextBefore: null,
          labels: { owner: "Owner", channel: "Channel", authors: [] },
        },
        { replace: true },
      ),
    );
    const { fence } = value(await drafts.load(account, target));
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const file = (id: string) => ({
      id,
      reservation: { commandId: crypto.randomUUID(), issuedAt: Date.now() },
    });
    const record = {
      id: crypto.randomUUID(),
      target,
      selectedAt: Date.now(),
      text: { body: "Keep this draft", mentions: [] },
      quote: null,
      files: [file(firstId)],
      attempt: null,
    };
    value(
      await drafts.save(
        fence,
        record,
        new Map([[firstId, new File(["first bytes"], "first.txt")]]),
      ),
    );
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "drafts")
        throw new DOMException(
          "Synthetic metadata quota after file changes",
          "QuotaExceededError",
        );
      return put.apply(this, args);
    };
    let failure;
    try {
      failure = await drafts.save(
        fence,
        {
          ...record,
          text: { body: "Must roll back", mentions: [] },
          files: [file(secondId)],
        },
        new Map([[secondId, new File(["second bytes"], "second.txt")]]),
      );
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const restored = value(await drafts.restore(fence, record.id));
    value(await cache.clearHistory());
    const afterClear = value(await drafts.restore(fence, record.id));
    value(await drafts.retire(account, target.owner));
    const staleSave = await drafts.save(fence, record, new Map());
    const current = value(await drafts.load(account, target));
    return {
      failure,
      restored: restored.record.text.body,
      files: [...restored.files.keys()],
      bytes: await restored.files.get(firstId)?.text(),
      firstId,
      afterClear: afterClear.record.text.body,
      staleSave,
      remaining: current.records.length,
    };
  }, modulePath);
  expect(result).toMatchObject({
    failure: { kind: "unavailable", reason: "quota" },
    restored: "Keep this draft",
    bytes: "first bytes",
    afterClear: "Keep this draft",
    staleSave: { kind: "stale" },
    remaining: 0,
  });
  expect(result.files).toEqual([result.firstId]);
});

test("a different tab replaces the account before a stale draft can commit", async ({
  page,
  moduleOrigin: origin,
  context,
}) => {
  await page.goto(origin);
  const first = await page.evaluate(async (path) => {
    const { historyCache: cache, draftStorage: drafts } = (await import(
      path
    )) as Storage;
    const capture = await cache.captureAccount();
    if (capture.kind !== "ok") throw new Error("capture");
    const account = await cache.activateAccount(capture.value, {
      accountId: "first",
      label: "First",
    });
    if (account.kind !== "ok") throw new Error("account");
    const target = {
      owner: { kind: "conversation" as const, id: "owner" },
      channelId: "channel",
      label: "Room",
    };
    const loaded = await drafts.load(account.value, target);
    if (loaded.kind !== "ok") throw new Error("load");
    cache.subscribe((event, source) =>
      sessionStorage.setItem("invalidation", `${source}:${event.type}`),
    );
    return {
      fence: loaded.value.fence,
      record: {
        id: crypto.randomUUID(),
        target,
        selectedAt: Date.now(),
        text: { body: "Old account", mentions: [] },
        quote: null,
        files: [],
        attempt: null,
      },
    };
  }, modulePath);
  const other = await context.newPage();
  await other.goto(origin);
  expect(
    await other.evaluate(async (path) => {
      const { historyCache: cache } = (await import(path)) as Storage;
      const capture = await cache.captureAccount();
      if (capture.kind !== "ok") throw new Error("capture");
      return (
        await cache.activateAccount(capture.value, {
          accountId: "second",
          label: "Second",
        })
      ).kind;
    }, modulePath),
  ).toBe("ok");
  expect(
    await page.evaluate(
      async ({ path, first }) => {
        const { draftStorage: drafts } = (await import(path)) as Storage;
        return drafts.save(first.fence, first.record, new Map());
      },
      { path: modulePath, first },
    ),
  ).toEqual({ kind: "stale" });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("invalidation")))
    .toBe("remote:account");
  await other.close();
});

test("blocked opening and closing during opening cannot create a late writable cache", async ({
  page,
  moduleOrigin: origin,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async (path) => {
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("vaskel-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const { createHistoryCache } = (await import(path)) as Storage;
    const blockedCache = createHistoryCache();
    const blocked = await blockedCache.captureAccount();
    blockedCache.close();
    blocker.close();
    const closingCache = createHistoryCache();
    const pending = closingCache.captureAccount();
    closingCache.close();
    const closed = await pending;
    const fresh = createHistoryCache();
    const available = await fresh.captureAccount();
    fresh.close();
    return { blocked, closed, available: available.kind };
  }, modulePath);
  expect(result).toEqual({
    blocked: { kind: "unavailable", reason: "blocked" },
    closed: { kind: "unavailable", reason: "closed" },
    available: "ok",
  });
});

test("opening timeout settles before a blocked request is released", async ({
  page,
  moduleOrigin: origin,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async (path) => {
    const open = IDBFactory.prototype.open;
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("vaskel-local", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    IDBFactory.prototype.open = function (...args) {
      const request = open.apply(this, args);
      request.addEventListener("blocked", (event) =>
        event.stopImmediatePropagation(),
      );
      return request;
    };
    const { createHistoryCache } = (await import(path)) as Storage;
    const cache = createHistoryCache();
    let timeout;
    try {
      timeout = await cache.captureAccount();
    } finally {
      IDBFactory.prototype.open = open;
      cache.close();
      blocker.close();
    }
    const fresh = createHistoryCache();
    const available = await fresh.captureAccount();
    fresh.close();
    return { timeout, available: available.kind };
  }, modulePath);
  expect(result).toEqual({
    timeout: { kind: "unavailable", reason: "timeout" },
    available: "ok",
  });
});

test("account retirement still purges draft files after corrupt history disables reads", async ({
  page,
  moduleOrigin: origin,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async (path) => {
    const { historyCache: cache, draftStorage: drafts } = (await import(
      path
    )) as Storage;
    function value<T>(result: CacheResult<T>): T {
      if (result.kind !== "ok") throw new Error(JSON.stringify(result));
      return result.value;
    }
    const account = value(
      await cache.activateAccount(value(await cache.captureAccount()), {
        accountId: "account",
        label: "Account",
      }),
    );
    const target = {
      owner: { kind: "conversation" as const, id: "owner" },
      channelId: "channel",
      label: "Room",
    };
    const { fence } = value(await drafts.load(account, target));
    const id = crypto.randomUUID();
    value(
      await drafts.save(
        fence,
        {
          id: crypto.randomUUID(),
          target,
          selectedAt: Date.now(),
          text: { body: "Private draft", mentions: [] },
          quote: null,
          files: [
            {
              id,
              reservation: {
                commandId: crypto.randomUUID(),
                issuedAt: Date.now(),
              },
            },
          ],
          attempt: null,
        },
        new Map([[id, new File(["private bytes"], "private.txt")]]),
      ),
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("vaskel-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("snapshots", "readwrite");
      transaction
        .objectStore("snapshots")
        .put({ bad: "record" }, "invalid-key");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const corrupt = await cache.readAccount();
    const retired = await cache.invalidateAccount(account);
    const counts = await new Promise<number[]>((resolve, reject) => {
      const transaction = db.transaction(["drafts", "draftFiles"], "readonly");
      const records = transaction.objectStore("drafts").count();
      const files = transaction.objectStore("draftFiles").count();
      transaction.oncomplete = () => resolve([records.result, files.result]);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { corrupt, retired: retired.kind, counts };
  }, modulePath);
  expect(result).toEqual({
    corrupt: { kind: "unavailable", reason: "corrupt" },
    retired: "ok",
    counts: [0, 0],
  });
});
