// Renders the page to static markup after the two Vite builds and copies the
// repository's INSTALL.md next to it, so vaskel.com/INSTALL.md is the file
// hosts hand to their agent.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = new URL("../", import.meta.url);
const { render } = await import(new URL("dist/server/entry-server.js", site));
const page = new URL("dist/client/index.html", site);
const template = readFileSync(page, "utf8");
const marker = "<!--app-->";
if (!template.includes(marker))
  throw new Error("index.html lost its app marker");
writeFileSync(page, template.replace(marker, render()));
copyFileSync(
  fileURLToPath(new URL("../../INSTALL.md", site)),
  fileURLToPath(new URL("dist/client/INSTALL.md", site)),
);
console.log("prerendered index.html and copied INSTALL.md");
