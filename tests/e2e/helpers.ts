import type { BrowserContext, Page, Route } from "@playwright/test";
import { apiErrors, type ApiErrorCode } from "@vaskel/contracts/api";

export { deferred } from "@tests/shared/deferred";

/** Native oRPC error JSON, with domain data validated by the shared contract. */
export function apiErrorResponse(code: ApiErrorCode, data?: unknown) {
  const definition = apiErrors[code];
  return {
    status: definition.status,
    json: {
      defined: true,
      code,
      status: definition.status,
      message: code,
      ...("data" in definition ? { data: definition.data.parse(data) } : {}),
    },
  };
}

declare global {
  interface Window {
    /** Chimes this document played; see countChimes. */
    chimesPlayed?: number;
  }
}

/**
 * Counts chimes in every page of a context. Headless browsers play into a
 * silent output, so the count records the app's request to play: each chime
 * connects its output to the speakers once, whatever its notes.
 */
export async function countChimes(context: BrowserContext) {
  await context.addInitScript(() => {
    window.chimesPlayed = 0;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (
      this: AudioNode,
      ...args: unknown[]
    ) {
      if (args[0] instanceof AudioDestinationNode)
        window.chimesPlayed = (window.chimesPlayed ?? 0) + 1;
      return Reflect.apply(connect, this, args);
    };
  });
}
/**
 * Reading the count evaluates script in the page, which Playwright does as a
 * user gesture: it grants activation, so read it only after any gesture a test
 * is checking.
 */
export async function chimes(...pages: Page[]) {
  let played = 0;
  for (const page of pages)
    played += await page.evaluate(() => window.chimesPlayed ?? 0);
  return played;
}
/** Each tab decides from settings it read itself; tests wait for those reads. */
export const settingsRead = (tab: Page) =>
  tab.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notifications" &&
      response.request().method() === "GET",
  );

export function inboxFrames(page: Page) {
  const frames: Array<Record<string, unknown>> = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/api/account/events")) return;
    socket.on("framereceived", ({ payload }) => {
      try {
        frames.push(JSON.parse(String(payload)) as Record<string, unknown>);
      } catch {
        /* Protocol errors are asserted by transport tests. */
      }
    });
  });
  return frames;
}

/** Read the application's real IndexedDB, without importing or replacing its cache. */
export async function savedHistory(
  page: Page,
  store = "snapshots",
): Promise<string> {
  return page.evaluate(async (store) => {
    if (
      !(await indexedDB.databases()).some(
        (entry) => entry.name === "vaskel-local",
      )
    )
      return "[]";
    return new Promise<string>((resolve, reject) => {
      const opening = indexedDB.open("vaskel-local");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction(store, "readonly");
        const request = transaction.objectStore(store).getAll();
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => {
          database.close();
          resolve(JSON.stringify(request.result));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  }, store);
}

/** A held response may be canceled by correct Query cleanup before release. */
export async function fulfillHeld(
  route: Route,
  response: Awaited<ReturnType<Route["fetch"]>>,
) {
  try {
    await route.fulfill({ response });
  } catch (error) {
    if (
      !/Target closed|Target page, context or browser has been closed|Invalid InterceptionId|already handled/.test(
        String(error),
      )
    )
      throw error;
  }
}
