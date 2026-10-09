import { testAliases } from "../../tests/config/aliases.ts";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { fixturePoolOptions } from "./tools/vitest-pool.ts";

export default defineProject(async () => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      ...testAliases(new URL("./tests", import.meta.url)),
      "@/server": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [cloudflareTest(await fixturePoolOptions())],
  test: {
    name: "server-runtime",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/unit/**"],
    setupFiles: ["./tests/setup.ts"],
    // Bundle Mediabunny as Vite does for the Worker; its browser-mapped Node
    // module cannot be loaded directly by Vitest's workerd module evaluator.
    deps: {
      optimizer: { ssr: { enabled: true, include: ["mediabunny"] } },
    },
    maxWorkers: Math.min(4, availableParallelism()),
    // Vitest requires projects with different worker limits in separate groups.
    sequence: { groupOrder: 1 },
    testTimeout: 10_000,
  },
}));
