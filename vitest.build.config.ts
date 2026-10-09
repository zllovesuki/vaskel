import { testAliases } from "./tests/config/aliases.ts";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  resolve: { alias: testAliases(new URL("./tests", import.meta.url)) },
  test: {
    environment: "node",
    include: ["tests/build/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
