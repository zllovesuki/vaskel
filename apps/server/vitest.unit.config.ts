import { testAliases } from "../../tests/config/aliases.ts";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      ...testAliases(new URL("./tests", import.meta.url)),
      "@/server": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "server-unit",
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
