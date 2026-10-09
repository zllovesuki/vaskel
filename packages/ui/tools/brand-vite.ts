import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { SURFACES, type Surface } from "../src/brand.ts";

const master = new URL("../brand/", import.meta.url);
const types: Record<string, string> = {
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  webmanifest: "application/manifest+json",
};

/**
 * One committed master, copied at build: the surface's brand files are served
 * from packages/ui/brand in development and emitted at their stable root
 * names into the browser build, so both applications ship identical icons
 * without keeping copies.
 */
export function brandAssets(surface: Surface): Plugin {
  const files = SURFACES[surface];
  return {
    name: "vaskel-brand",
    applyToEnvironment: (environment) => environment.name === "client",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0]?.slice(1) ?? "";
        if (!files.includes(path)) return next();
        response.setHeader("Content-Type", types[path.split(".").at(-1)!]!);
        response.end(readFileSync(new URL(path, master)));
      });
    },
    // Only the bundle step emits; the development server serves the middleware above.
    generateBundle() {
      for (const file of files)
        this.emitFile({
          type: "asset",
          fileName: file,
          source: readFileSync(new URL(file, master)),
        });
    },
  };
}
