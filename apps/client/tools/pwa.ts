import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VitePWAOptions } from "vite-plugin-pwa";
import { shellContentTypes } from "../src/service-worker/assets.ts";

/** Workbox owns discovery, compilation and caching; vaskel supplies public-shell policy. */
export function offlineShellOptions(
  directory: string,
): Partial<VitePWAOptions> {
  return {
    strategies: "injectManifest",
    srcDir: fileURLToPath(new URL("../src", import.meta.url)),
    filename: "sw.ts",
    outDir: directory,
    registerType: "prompt",
    injectRegister: false,
    manifest: false,
    devOptions: { enabled: false },
    injectManifest: {
      buildPlugins: {
        vite: [
          {
            name: "vaskel-service-worker-licenses",
            config: () => ({
              build: { license: { fileName: "licenses/service-worker.md" } },
            }),
          },
        ],
      },
      rollupFormat: "iife",
      globDirectory: directory,
      globPatterns: ["index.html", "theme.js", "theme.css", "assets/**/*"],
      // Unicode-range font slices load on demand; system fonts cover cold offline use.
      globIgnores: ["**/*.map", "**/*.woff2"],
      // Precache every required asset; never silently omit a large chunk.
      maximumFileSizeToCacheInBytes: Number.MAX_SAFE_INTEGER,
      manifestTransforms: [
        async (entries) => ({
          manifest: await Promise.all(
            entries.map(async (entry) => {
              if (
                !/^(?:index\.html|theme\.(?:js|css)|assets\/[\w.~/-]+)$/.test(
                  entry.url,
                ) ||
                entry.url.includes("..") ||
                !shellContentTypes(entry.url)
              ) {
                throw new Error(`Unexpected offline shell asset: ${entry.url}`);
              }
              const body = await readFile(resolve(directory, entry.url));
              const integrity = `sha256-${createHash("sha256").update(body).digest("base64")}`;
              return entry.url === "index.html"
                ? {
                    ...entry,
                    url: "/",
                    integrity,
                    revision: createHash("sha256")
                      .update(body)
                      .update(await readFile(resolve(directory, "_headers")))
                      .digest("hex"),
                  }
                : { ...entry, url: `/${entry.url}`, integrity };
            }),
          ),
          warnings: [],
        }),
      ],
    },
  };
}
