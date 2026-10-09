import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config";

export default defineConfig(browserConfig, {
  testDir: "./tests/site",
  outputDir: ".local/site-browser-results",
});
