import { fileURLToPath } from "node:url";

/** The shared prefix must precede the workspace root in Vite's alias matching. */
export function testAliases(testRoot: URL) {
  return {
    "@tests/shared": fileURLToPath(new URL("../helpers", import.meta.url)),
    "@tests": fileURLToPath(testRoot),
  };
}
