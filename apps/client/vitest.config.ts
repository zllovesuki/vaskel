import { testAliases } from "../../tests/config/aliases.ts";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { lingui } from "@lingui/vite-plugin";

export default defineProject({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      ...testAliases(new URL("./tests", import.meta.url)),
      "@/client": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    lingui({
      configPath: fileURLToPath(new URL("./lingui.config.ts", import.meta.url)),
      failOnMissing: true,
      failOnCompileError: true,
    }),
  ],
  test: {
    name: "client-unit",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
