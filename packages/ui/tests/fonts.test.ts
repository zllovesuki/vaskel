import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { build } from "vite";
import { expect, it } from "vitest";
import { plexFonts } from "../tools/fonts-vite.ts";

async function fontCss(grouped: boolean) {
  const result = await build({
    configFile: false,
    root: fileURLToPath(new URL("../", import.meta.url)),
    plugins: grouped ? [plexFonts()] : [],
    logLevel: "silent",
    build: {
      write: false,
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      rolldownOptions: {
        input: fileURLToPath(new URL("../src/fonts.css", import.meta.url)),
      },
    },
  });
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Expected one font stylesheet build");
  const css = result.output.find((asset) => asset.fileName.endsWith(".css"));
  if (!css || css.type !== "asset" || typeof css.source !== "string")
    throw new Error("Missing built font stylesheet");
  return css.source;
}

function faces(css: string) {
  const result = new Map<string, Record<string, string>[]>();
  postcss.parse(css).walkAtRules("font-face", (rule) => {
    const descriptors: Record<string, string> = {};
    rule.walkDecls((node) => {
      if (node.prop !== "font-display") descriptors[node.prop] = node.value;
    });
    const key = ["font-family", "font-style", "font-weight", "font-stretch"]
      .map((name) => descriptors[name])
      .join("\0");
    const entries = result.get(key) ?? [];
    entries.push(descriptors);
    result.set(key, entries);
  });
  return result;
}

it("groups the published CJK maps without changing faces or slice precedence", async () => {
  const original = await fontCss(false);
  const grouped = await fontCss(true);

  // Source order matters when ranges overlap within the same face. Compare
  // every descriptor and URL in order for each family/style/weight/stretch.
  expect(faces(grouped)).toEqual(faces(original));
});
