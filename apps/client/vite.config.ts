import { defineConfig, normalizePath } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";
import { lingui } from "@lingui/vite-plugin";
import { brandAssets } from "@vaskel/ui/brand-vite";
import { plexFonts } from "@vaskel/ui/fonts-vite";
import { licenseNotices } from "@vaskel/ui/licenses-vite";
import { offlineShellOptions } from "./tools/pwa.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@/client": fileURLToPath(new URL("./src", import.meta.url)),
      "@/server": fileURLToPath(new URL("../server/src", import.meta.url)),
    },
  },
  plugins: [
    react(),
    lingui({
      configPath: fileURLToPath(new URL("./lingui.config.ts", import.meta.url)),
      failOnMissing: true,
      failOnCompileError: true,
    }),
    tailwindcss(),
    cloudflare({
      configPath: fileURLToPath(
        new URL("../server/wrangler.jsonc", import.meta.url),
      ),
      persistState: {
        path: fileURLToPath(
          new URL("../server/.wrangler/state", import.meta.url),
        ),
      },
    }),
    VitePWA(
      offlineShellOptions(
        fileURLToPath(new URL("./dist/client", import.meta.url)),
      ),
    ),
    brandAssets("app"),
    plexFonts(),
    licenseNotices(),
  ],
  server: {
    watch: {
      ignored: [
        normalizePath(
          fileURLToPath(new URL("../../.worktrees/**", import.meta.url)),
        ),
        normalizePath(
          fileURLToPath(new URL("../../.local/**", import.meta.url)),
        ),
      ],
    },
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  name: "vendor-react",
                  test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
                  entriesAware: true,
                  priority: 100,
                },
              ],
            },
          },
        },
      },
    },
  },
  build: {
    license: { fileName: "licenses/dependencies.md" },
    outDir: "dist",
    target: "es2023",
    manifest: true,
    // Optional font slices must stay separate from CSS and satisfy font-src 'self'.
    assetsInlineLimit: (path) => (path.endsWith(".woff2") ? false : undefined),
  },
});
