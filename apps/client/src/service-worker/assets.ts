const contentTypes: Record<string, readonly string[]> = {
  html: ["text/html"],
  js: ["text/javascript", "application/javascript"],
  css: ["text/css"],
  woff2: ["font/woff2"],
  woff: ["font/woff"],
  svg: ["image/svg+xml"],
  png: ["image/png"],
  webp: ["image/webp"],
  ico: ["image/x-icon", "image/vnd.microsoft.icon"],
};

/** Shared by the build allowlist and the browser worker's response policy. */
export function shellContentTypes(path: string) {
  return contentTypes[path === "/" ? "html" : (path.split(".").at(-1) ?? "")];
}
