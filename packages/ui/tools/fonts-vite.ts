import type { AtRule, Plugin as PostcssPlugin } from "postcss";
import type { Plugin } from "vite";

/**
 * IBM's Plex stylesheets declare no font-display, so a browser would hide
 * text for up to three seconds while a slice loads; swap keeps it readable in
 * the regional fallback fonts meanwhile.
 */
const fontStyles: PostcssPlugin = {
  postcssPlugin: "vaskel-font-styles",
  AtRule: {
    "font-face": (rule) => {
      if (
        !rule.nodes?.some(
          (node) => node.type === "decl" && node.prop === "font-display",
        )
      )
        // The rule's source lets Vite resolve url()s against IBM's sheet.
        rule.append({
          prop: "font-display",
          value: "swap",
          ...(rule.source && { source: rule.source }),
        });
    },
  },
  OnceExit(root) {
    // Group matching maps across weights so gzip can reuse their character lists.
    // Limit reordering to flat font sheets, leaving layers and conditions intact.
    if (
      root.nodes.some(
        (node) =>
          node.type !== "comment" &&
          !(node.type === "atrule" && node.name === "font-face"),
      )
    )
      return;
    const previous = new Map<string, AtRule>();
    for (const rule of [...root.nodes]) {
      if (rule.type !== "atrule") continue;
      const descriptors: Record<string, string> = {};
      rule.walkDecls((node) => {
        descriptors[node.prop] = node.value;
      });
      const range = descriptors["unicode-range"];
      if (!range) continue;
      const key = `${descriptors["font-family"]}\0${range}`;
      previous.get(key)?.after(rule);
      previous.set(key, rule);
    }
  },
};

/**
 * Serves IBM's Plex files as IBM publishes them. Their names can contain
 * spaces ("IBM Plex Sans Var-Roman-Latin1.woff2"); emitted names keep the
 * bundler's default sanitising and turn whitespace into hyphens, so asset
 * URLs stay plain paths.
 */
export function plexFonts(): Plugin {
  return {
    name: "vaskel-plex-fonts",
    config: () => ({
      css: { postcss: { plugins: [fontStyles] } },
      build: {
        rolldownOptions: {
          output: {
            sanitizeFileName: (name: string) =>
              name.replace(/[\0?*]/g, "").replace(/\s+/g, "-"),
          },
        },
      },
    }),
  };
}
