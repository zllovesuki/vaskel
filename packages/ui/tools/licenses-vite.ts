import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Vite collects JS licenses; font assets need their original OFL notices too. */
export function licenseNotices(): Plugin {
  return {
    name: "vaskel-license-notices",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      const files = {
        "LICENSE.txt": "../../../LICENSE",
        "licenses/fonts/ibm-plex-mono.txt":
          "../node_modules/@ibm/plex-mono/LICENSE.txt",
        "licenses/fonts/ibm-plex-sans-variable.txt":
          "../node_modules/@ibm/plex-sans-variable/LICENSE.txt",
        "licenses/fonts/plyra-sans.txt": "../node_modules/plyra-sans/OFL.txt",
      };
      for (const [fileName, path] of Object.entries(files))
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(new URL(path, import.meta.url)),
        });
    },
  };
}
