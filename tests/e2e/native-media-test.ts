import { browserModuleTest } from "@tests/e2e/browser-module";

export const test = browserModuleTest({
  entry: "tests/e2e/media-transfer-fixture.ts",
  filename: "media.js",
  html: "<!doctype html><title>Native media transfer proof</title><button>Start listener</button>",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
