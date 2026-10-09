import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    projects: [
      "./apps/client/vitest.config.ts",
      "./apps/site/vitest.config.ts",
      "./packages/ui/vitest.config.ts",
      "./apps/server/vitest.unit.config.ts",
      "./apps/server/vitest.config.ts",
    ],
  },
});
