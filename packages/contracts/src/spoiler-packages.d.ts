// The published ESM files share the packages' public declarations.
declare module "micromark-extension-inline-spoiler/dist/index.esm.js" {
  export { spoiler } from "micromark-extension-inline-spoiler";
}
declare module "mdast-util-inline-spoiler/dist/index.esm.js" {
  export {
    spoilerFromMarkdown,
    spoilerToMarkdown,
  } from "mdast-util-inline-spoiler";
}
