import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config";

export default defineConfig(browserConfig, {
  testMatch: "**/*.measure.ts",
  outputDir: ".local/browser-measurements",
});
