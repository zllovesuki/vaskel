import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import {
  fixtureAuthVars,
  fixtureDurableObjects,
  fixtureModuleRules,
} from "../../../tests/config/bindings.ts";

const fromServer = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

/** Production Wrangler configuration with the fixture Worker and Miniflare overrides. */
export async function fixturePoolOptions(vars: Record<string, string> = {}) {
  // D1 migrations reach tests/setup.ts through a binding, the plugin's documented path.
  const TEST_MIGRATIONS = [
    ...(await readD1Migrations(fromServer("migrations/d1"))),
    ...(await readD1Migrations(fromServer("tests/fixtures/d1-migrations"))),
  ];
  return {
    wrangler: { configPath: fromServer("wrangler.jsonc") },
    main: fromServer("tests/fixtures/worker.ts"),
    // Official Miniflare overrides take precedence over Wrangler/local vars.
    miniflare: {
      bindings: { ...fixtureAuthVars, ...vars, TEST_MIGRATIONS },
      durableObjects: fixtureDurableObjects,
      modulesRules: fixtureModuleRules,
    },
  };
}
