/// <reference path="./spoiler-packages.d.ts" />
import { spoiler } from "micromark-extension-inline-spoiler/dist/index.esm.js";
import { spoilerFromMarkdown } from "mdast-util-inline-spoiler/dist/index.esm.js";
import type { Processor } from "unified";

// Explicit published ESM entries avoid these packages' legacy browser UMD
// builds in Vite and workerd. The dependencies own all spoiler grammar.
export function remarkSpoiler(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(spoiler());
  (data.fromMarkdownExtensions ??= []).push(spoilerFromMarkdown());
}
