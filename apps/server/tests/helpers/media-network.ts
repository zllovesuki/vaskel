import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import type { MediaSfu } from "@tests/fixtures/media-sfu";
export const mediaNetwork = setupNetwork();
// Structural diagnostics only: never retain URLs, headers or upstream errors.
export const mediaNetworkProbe = {
  matched: 0,
  rebuilt: 0,
  fixtureReplies: 0,
  blocked: 0,
  failures: 0,
  dispatched: 0,
  interceptorFailures: 0,
};
let guardedFetch: typeof fetch | undefined;
mediaNetwork.configure({ onUnhandledFrame: "error" });
export function useMediaSfu(fake: MediaSfu) {
  for (const key of Object.keys(
    mediaNetworkProbe,
  ) as (keyof typeof mediaNetworkProbe)[]) {
    mediaNetworkProbe[key] = 0;
  }
  if (globalThis.fetch !== guardedFetch) {
    const interceptedFetch = globalThis.fetch;
    guardedFetch = async (input, init) => {
      mediaNetworkProbe.dispatched++;
      try {
        const url = new URL(
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input.url,
        );
        const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        );
        if (
          url.origin !== "https://rtc.live.cloudflare.com" ||
          !url.pathname.startsWith("/v1/apps/fixture-app/") ||
          headers.get("authorization") !== "Bearer fixture-secret"
        ) {
          mediaNetworkProbe.blocked++;
          return HttpResponse.json(
            { errorCode: "unexpected_fixture_request" },
            { status: 503 },
          );
        }
        return await interceptedFetch(input, init);
      } catch {
        mediaNetworkProbe.interceptorFailures++;
        return HttpResponse.json(
          { errorCode: "unexpected_fixture_request" },
          { status: 503 },
        );
      }
    };
    Object.defineProperty(globalThis, "fetch", {
      value: guardedFetch,
      configurable: true,
      writable: true,
    });
  }
  mediaNetwork.use(
    http.all(
      "https://rtc.live.cloudflare.com/v1/apps/fixture-app/*",
      async ({ request }) => {
        mediaNetworkProbe.matched++;
        try {
          const rebuilt = new Request(request.url, {
            method: request.method,
            headers: new Headers(Array.from(request.headers)),
            body:
              request.method === "GET" || request.method === "HEAD"
                ? null
                : await request.text(),
          });
          mediaNetworkProbe.rebuilt++;
          const response = await fake.fetcher(rebuilt);
          mediaNetworkProbe.fixtureReplies++;
          return response;
        } catch {
          mediaNetworkProbe.failures++;
          return HttpResponse.json(
            { errorCode: "unexpected_fixture_request" },
            { status: 503 },
          );
        }
      },
    ),
    http.all("*", () => {
      mediaNetworkProbe.blocked++;
      return HttpResponse.json(
        { errorCode: "unexpected_fixture_request" },
        { status: 503 },
      );
    }),
  );
}
