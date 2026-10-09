// Regenerates the committed brand master in packages/ui/brand from
// @vaskel/ui/brand: text files directly, rasters through the Playwright
// Chromium the browser tests already use, the ICO from the tab-size rasters,
// and the share card set in the IBM Plex Sans the applications bundle.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  brandColours,
  ICO,
  pngFiles,
  SHARE_CARD,
  SHARE_CARD_FONT,
  shareCardHtml,
  textFiles,
} from "@vaskel/ui/brand";

const ui = new URL("../packages/ui/", import.meta.url);
const master = new URL("brand/", ui);
const colours = brandColours(
  readFileSync(new URL("src/theme.css", ui), "utf8"),
);
const write = (path: string, bytes: string | Uint8Array) => {
  const file = fileURLToPath(new URL(path, master));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`packages/ui/brand/${path}`);
};

const text = textFiles(colours);
for (const [path, body] of Object.entries(text)) write(path, body);

const browser = await chromium.launch();
async function raster(
  html: string,
  width: number,
  height: number,
  transparent: boolean,
) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  await page.setContent(html);
  await page.evaluate("document.fonts.ready");
  const png = await page.screenshot({ omitBackground: transparent });
  await page.close();
  return png;
}
const image = (svg: string, size: number) =>
  `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;utf8,${encodeURIComponent(svg)}" width="${size}" height="${size}" style="display:block"></body>`;

for (const { path, size, svg } of pngFiles(colours))
  write(path, await raster(image(svg, size), size, size, true));

// PNG members, which every current browser and Windows accept in an ICO.
const members = await Promise.all(
  ICO.sizes.map((size) =>
    raster(image(text["favicon.svg"]!, size), size, size, true),
  ),
);
const directory = Buffer.alloc(6 + 16 * members.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(members.length, 4);
let offset = directory.length;
members.forEach((png, index) => {
  const entry = 6 + 16 * index;
  directory.writeUInt8(ICO.sizes[index]!, entry);
  directory.writeUInt8(ICO.sizes[index]!, entry + 1);
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.byteLength, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.byteLength;
});
write(ICO.path, Buffer.concat([directory, ...members]));

const font = createRequire(new URL("package.json", ui)).resolve(
  "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2",
);
const fontFace = `@font-face{font-family:"${SHARE_CARD_FONT}";font-weight:100 700;src:url(data:font/woff2;base64,${readFileSync(font).toString("base64")}) format("woff2")}`;
write(
  SHARE_CARD.path,
  await raster(
    shareCardHtml(colours, fontFace),
    SHARE_CARD.width,
    SHARE_CARD.height,
    false,
  ),
);
await browser.close();
