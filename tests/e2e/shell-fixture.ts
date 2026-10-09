import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Manifest } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import type { Page } from "@playwright/test";
import { test as base } from "@tests/e2e/fixtures";
import { offlineShellOptions } from "../../apps/client/tools/pwa";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const digest = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("base64");

export async function shellFiles(directory: string) {
  const html = await readFile(resolve(directory, "index.html"), "utf8");
  const manifest = JSON.parse(
    await readFile(resolve(directory, ".vite/manifest.json"), "utf8"),
  ) as Manifest;
  return [
    ...new Set([
      "index.html",
      ...[...html.matchAll(/(?:src|href)="\/([^"/]+\.(?:js|css))"/g)].map(
        (match) => match[1]!,
      ),
      ...Object.values(manifest).flatMap((entry) => [
        entry.file,
        ...(entry.css ?? []),
        ...(entry.assets ?? []),
      ]),
    ]),
  ].filter((file) => !file.endsWith(".woff2"));
}

export async function installedKeys(page: Page) {
  return page.evaluate(async () => {
    const result: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      result[name] = (await (await caches.open(name)).keys()).map(
        (entry) => entry.url,
      );
    }
    return result;
  });
}

/** Observe native lifecycle states, including an install already in progress. */
export async function updateWorker(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error("No installed shell");
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker installation did not settle")),
        10_000,
      );
      const observe = () => {
        const candidate = registration.installing;
        if (!candidate) return;
        const changed = () => {
          if (
            candidate.state === "installed" ||
            candidate.state === "redundant"
          ) {
            clearTimeout(timer);
            resolve(candidate.state);
          }
        };
        candidate.addEventListener("statechange", changed);
        changed();
      };
      registration.addEventListener("updatefound", observe, { once: true });
      observe();
    });
    await registration.update();
    return result;
  });
}

/** Compile production registration and worker modules; never rewrite the manifest or app dist. */
async function buildShellVersions() {
  const parent = resolve(root, ".local/browser-runs");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "shell-"));
  const versions: Record<
    string,
    { directory: string; files: string[]; policy: string }
  > = {};
  try {
    for (const version of ["a", "b", "c"]) {
      const source = resolve(directory, version);
      const output = resolve(source, "dist");
      const title = version === "a" ? "A" : "B";
      await mkdir(resolve(source, "public"), { recursive: true });
      await writeFile(
        resolve(source, "index.html"),
        `<!doctype html><title>Shell ${title}</title><body><h1>Shell ${title}</h1><button hidden>Update now</button><script type="module" src="/main.ts"></script></body>`,
      );
      await writeFile(
        resolve(source, "main.ts"),
        `import { registerOfflineShell, getShellUpdateAvailable, subscribeShellUpdate, reloadToUpdate } from '@/client/shell/register';
const button = document.querySelector('button');
const render = () => { button.hidden = !getShellUpdateAvailable(); };
subscribeShellUpdate(render);
button.addEventListener('click', reloadToUpdate);
registerOfflineShell();
render();
import('./lazy').then(({ text }) => document.body.dataset.loaded = text);`,
      );
      await writeFile(
        resolve(source, "lazy.ts"),
        `export const text = ${JSON.stringify(title)};`,
      );
      const policy = version === "c" ? "new" : "old";
      await writeFile(
        resolve(source, "public/_headers"),
        `/\n  X-Fixture-Policy: ${policy}\n`,
      );
      await build({
        configFile: false,
        root: source,
        logLevel: "silent",
        resolve: {
          alias: {
            "@/client": resolve(root, "apps/client/src"),
            "workbox-window": resolve(
              root,
              "apps/client/node_modules/workbox-window",
            ),
          },
        },
        plugins: [VitePWA(offlineShellOptions(output))],
        build: { outDir: output, manifest: true, target: "es2023" },
      });
      versions[version] = {
        directory: output,
        files: await shellFiles(output),
        policy,
      };
    }
    return {
      versions,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Only immutable build output is shared; every test owns its origin and faults.
async function shellFixture(
  versions: Awaited<ReturnType<typeof buildShellVersions>>["versions"],
) {
  const state = {
    version: "a",
    fault: "" as "" | "missing" | "corrupt" | "mime" | "quota",
    requests: [] as {
      path: string;
      cookie: string | undefined;
      status: number;
    }[],
  };
  const faultPath = `/${versions.b!.files.find((file) => file.includes("lazy-"))!}`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const selected = versions[state.version]!;
    const observed = {
      path: request.url!,
      cookie: request.headers.cookie,
      status: 200,
    };
    state.requests.push(observed);
    response.setHeader(
      "Cache-Control",
      url.pathname === "/sw.js" ? "no-cache, must-revalidate" : "no-store",
    );
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Fixture-Policy", selected.policy);
    try {
      if (url.pathname === "/sw.js") {
        response.setHeader("Content-Type", "text/javascript");
        const prefix =
          state.fault === "quota"
            ? 'Cache.prototype.put = async () => { throw new DOMException("Synthetic storage exhaustion", "QuotaExceededError"); };\n'
            : "";
        response.end(
          prefix +
            (await readFile(resolve(selected.directory, "sw.js"), "utf8")),
        );
      } else if (url.pathname === "/probe") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>Worker probe</title>");
      } else {
        const file =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (
          !selected.files.includes(file) ||
          (url.pathname === faultPath && state.fault === "missing")
        ) {
          observed.status = response.statusCode = 404;
          response.end("Missing synthetic asset");
          return;
        }
        response.setHeader(
          "Content-Type",
          url.pathname === faultPath && state.fault === "mime"
            ? "text/plain"
            : file.endsWith(".html")
              ? "text/html"
              : "text/javascript",
        );
        response.end(
          url.pathname === faultPath && state.fault === "corrupt"
            ? "Incorrect synthetic asset bytes"
            : await readFile(resolve(selected.directory, file)),
        );
      }
    } catch {
      response.statusCode = 500;
      response.end("Shell fixture failure");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing shell fixture port");
  const stop = () =>
    new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    versions,
    faultPath,
    stop,
  };
}

export const test = base.extend<
  { shell: Awaited<ReturnType<typeof shellFixture>> },
  { shellVersions: Awaited<ReturnType<typeof buildShellVersions>>["versions"] }
>({
  shellVersions: [
    // Playwright requires destructuring even without fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const built = await buildShellVersions();
      try {
        await use(built.versions);
      } finally {
        await built.close();
      }
    },
    { scope: "worker" },
  ],
  shell: async ({ shellVersions }, use) => {
    const fixture = await shellFixture(shellVersions);
    try {
      await use(fixture);
    } finally {
      await fixture.stop();
    }
  },
});
