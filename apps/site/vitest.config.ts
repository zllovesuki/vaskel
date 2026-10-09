import { testAliases } from "../../tests/config/aliases.ts";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      ...testAliases(new URL("./tests", import.meta.url)),
      "@/site": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: { name: "site-unit", include: ["tests/**/*.test.ts"] },
});
