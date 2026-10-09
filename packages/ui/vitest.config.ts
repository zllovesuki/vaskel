import { testAliases } from "../../tests/config/aliases.ts";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: testAliases(new URL("./tests", import.meta.url)) },
  test: {
    name: "ui-unit",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
