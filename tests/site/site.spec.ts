import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createServer } from "vite";
import { createTestHarness, type TestHarness } from "wrangler";

const root = resolve(import.meta.dirname, "../..");
const setupPrompt =
  "Set up vaskel. using https://vaskel.com/INSTALL.md. Guide me through any prerequisites.";
let directory: string;
let site: TestHarness;
let origin: string;

test.beforeAll(async () => {
  const runs = resolve(root, ".local/browser-runs");
  await mkdir(runs, { recursive: true });
  directory = await mkdtemp(resolve(runs, "site-"));
  site = createTestHarness({
    root: directory,
    workers: [{ configPath: resolve(root, "apps/site/wrangler.jsonc") }],
  });
  origin = (await site.listen()).url.origin;
});

test.afterAll(async () => {
  await site?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("the built page hydrates and loads its styles and fonts under its CSP", async ({
  browser,
}) => {
  const page = await browser.newPage({ locale: "zh-TW" });
  try {
    const errors = browserErrors(page);
    const response = await page.goto(origin);
    expect(response?.headers()["content-security-policy"]).toContain(
      "style-src 'self'",
    );
    await expect(page.locator(".ws")).toHaveAttribute("lang", "zh-Hant");
    // The CJK sheet arrives after hydration; its TC face must load under the CSP.
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await document.fonts.load('16px "Plyra Sans TC"', "繁體中文"))
              .length,
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(errors).toEqual([]);
    expect(
      await page
        .locator(".person-hue")
        .first()
        .evaluate((node) => getComputedStyle(node).getPropertyValue("--hue")),
    ).not.toBe("");
    await expect(page.locator(".ws")).toHaveCSS("font-family", /Plyra Sans TC/);
    await page.getByRole("button", { name: "general", exact: true }).click();
    await expect(page.locator(".ws-main h1")).toHaveText("general");
    const install = await page.request.get(`${origin}/INSTALL.md`);
    expect(install.status()).toBe(200);
    expect(install.headers()["content-type"]).toContain("text/markdown");
  } finally {
    await page.close();
  }
});

test("copy confirms a successful clipboard write", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(origin);
  await page.getByRole("button", { name: "Copy setup prompt" }).click();
  await expect(
    page.getByRole("button", { name: "Copy setup prompt" }),
  ).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    setupPrompt,
  );
});

for (const clipboard of ["denied", "missing"] as const) {
  test(`copy offers the complete prompt when the clipboard is ${clipboard}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          mode === "missing"
            ? undefined
            : {
                writeText: async () => {
                  throw new DOMException("Denied", "NotAllowedError");
                },
              },
      });
    }, clipboard);
    await page.goto(origin);
    const copy = page.getByRole("button", { name: "Copy setup prompt" });
    await copy.click();
    await expect(copy).toHaveText("Copy prompt");
    const prompt = page.getByRole("textbox", { name: "Setup prompt" });
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(setupPrompt);
    expect(
      await prompt.evaluate((input: HTMLInputElement) =>
        input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
      ),
    ).toBe(setupPrompt);
    await expect(page.getByRole("status")).toContainText(
      "Copy the selected prompt manually",
    );
  });
}

test("the development page mounts without a hydration error", async ({
  page,
}) => {
  const dev = await createServer({
    configFile: resolve(root, "apps/site/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await dev.listen();
    const url = dev.resolvedUrls?.local[0];
    if (!url) throw new Error("The site development server has no local URL");
    const errors = browserErrors(page);
    await page.goto(url);
    await page.getByRole("button", { name: "general", exact: true }).click();
    await expect(page.locator(".ws-main h1")).toHaveText("general");
    expect(errors).toEqual([]);
  } finally {
    await dev.close();
  }
});
