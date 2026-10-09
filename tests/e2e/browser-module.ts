import { testAliases } from "@tests/config/aliases";
import { test as base } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

interface BrowserModule {
  entry: string;
  filename: string;
  html: string;
  define?: Record<string, string>;
}

/** Compile once per worker; each case gets its own static server and origin. */
export function browserModuleTest(options: BrowserModule) {
  return base.extend<{ moduleOrigin: string }, { moduleScript: Buffer }>({
    moduleScript: [
      // Playwright requires destructuring even without fixture dependencies.
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const root = fileURLToPath(new URL("../..", import.meta.url));
        const parent = resolve(root, ".local/browser-runs");
        await mkdir(parent, { recursive: true });
        const directory = await mkdtemp(resolve(parent, "browser-module-"));
        let script: Buffer;
        try {
          await build({
            configFile: false,
            root: resolve(root, "apps/client"),
            logLevel: "silent",
            ...(options.define ? { define: options.define } : {}),
            resolve: {
              alias: {
                ...testAliases(new URL("..", import.meta.url)),
                "@/client": resolve(root, "apps/client/src"),
              },
            },
            build: {
              outDir: directory,
              target: "es2023",
              lib: {
                entry: resolve(root, options.entry),
                formats: ["es"],
                fileName: () => options.filename,
              },
            },
          });
          script = await readFile(resolve(directory, options.filename));
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        await use(script);
      },
      { scope: "worker" },
    ],
    moduleOrigin: async ({ moduleScript }, use) => {
      const server = createServer((request, response) => {
        const module = request.url === `/${options.filename}`;
        response.setHeader(
          "Content-Type",
          module ? "text/javascript" : "text/html",
        );
        response.end(module ? moduleScript : options.html);
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing fixture port");
        await use(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise<void>((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
          server.closeAllConnections();
        });
      }
    },
  });
}
