import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { brandAssets } from "@vaskel/ui/brand-vite";
import { plexFonts } from "@vaskel/ui/fonts-vite";
import { licenseNotices } from "@vaskel/ui/licenses-vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    brandAssets("site"),
    plexFonts(),
    licenseNotices(),
  ],
  resolve: {
    alias: { "@/site": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    license: { fileName: "licenses/dependencies.md" },
    outDir: "dist/client",
    target: "es2023",
    emptyOutDir: true,
    // Keep font slices on the same origin permitted by the site's CSP.
    assetsInlineLimit: 0,
  },
});
