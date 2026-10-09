import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { savedHistory } from "@tests/e2e/helpers";
import { deferred } from "@tests/shared/deferred";

test("emoji insertion replaces the selection, preserves mentions and retires on disconnect", async ({
  app,
  page,
}) => {
  const room = await app.room("Emoji input");
  await app.open(page, app.member, roomPath(room));
  const composer = page.getByLabel(/^Message /);
  const trigger = page.getByRole("button", {
    name: "Insert emoji",
    exact: true,
  });
  const picker = page.getByRole("dialog", {
    name: "Insert emoji",
    exact: true,
  });

  await composer.fill("replace @Browser");
  await page.getByRole("option", { name: "Browser Host", exact: true }).click();
  await composer.pressSequentially("tail");
  await composer.evaluate((input: HTMLTextAreaElement) =>
    input.setSelectionRange(0, 7),
  );
  await trigger.click();
  await expect(
    picker.getByRole("button", { name: "Thumbs up", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("replace @Browser Host tail");

  // Keyboard selection exercises focus transfer and the same palette as reactions.
  await trigger.focus();
  await trigger.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(
    picker.getByRole("button", { name: "Red heart", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("❤️ @Browser Host tail");
  expect(
    await composer.evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([2, 2]);
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("");
  const original = (await app.snapshot(app.member, room)).messages[0]!;
  expect(original.body).toBe(
    `❤️ [](/mentions/${app.owner.profile.userId}) tail`,
  );
  expect(original.mentions).toEqual([app.owner.profile.userId]);

  // Selecting a mention itself removes its identity instead of leaving a hidden recipient.
  await composer.fill("@Browser");
  await page.getByRole("option", { name: "Browser Host", exact: true }).click();
  await composer.evaluate((input: HTMLTextAreaElement) =>
    input.setSelectionRange(0, "@Browser Host".length),
  );
  await trigger.click();
  await picker
    .getByRole("button", { name: "Party popper", exact: true })
    .click();
  await expect(composer).toHaveValue("🎉 ");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("");
  const messages = (await app.snapshot(app.member, room)).messages;
  expect(messages).toHaveLength(2);
  expect(messages[1]!.mentions).toEqual([]);

  // The shared picker still sends a reaction rather than editing the composer.
  const row = page.locator("article.message-row").first();
  await row.hover();
  await row.getByRole("button", { name: "React", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Add a reaction", exact: true })
    .getByRole("button", { name: "Party popper", exact: true })
    .click();
  await expect
    .poll(
      async () => (await app.snapshot(app.member, room)).messages[0]!.reactions,
    )
    .toEqual([{ emoji: "🎉", count: 1, mine: true }]);

  await composer.fill("Keep my draft");
  await trigger.click();
  await expect(picker).toBeVisible();
  await page.context().setOffline(true);
  await expect(trigger).toBeDisabled();
  await expect(picker).toHaveCount(0);
  await page.context().setOffline(false);
  await expect(trigger).toBeEnabled();
  await expect(picker).toHaveCount(0);
  await expect(composer).toHaveValue("Keep my draft");
});

test("Enter inserts a line while Shift+Enter sends outside composition and keeps focus for follow-ups", async ({
  app,
  page,
}) => {
  const room = await app.room("Composer keys");
  await app.open(page, app.member, roomPath(room));
  const composer = page.getByRole("textbox", { name: /^Message / });
  const sendPath = `${apiPath(room)}/send`;
  let sends = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === sendPath) sends++;
  });

  await composer.fill("第一行");
  await composer.press("Enter");
  await composer.pressSequentially("second line");
  const body = "第一行\nsecond line";
  await expect(composer).toHaveValue(body);
  expect(sends).toBe(0);

  // A synthetic composition boundary checks shortcut admission, not a native IME.
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    isComposing: true,
    keyCode: 229,
  });
  await expect(composer).toHaveValue(body);
  expect((await app.snapshot(app.member, room)).messages).toHaveLength(0);
  expect(sends).toBe(0);

  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === sendPath && response.ok(),
  );
  await composer.press("Shift+Enter");
  await accepted;
  await expect(composer).toHaveValue("");
  const messages = (await app.snapshot(app.member, room)).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]?.body).toBe(body);
  expect(sends).toBe(1);
  await expect(composer).toBeFocused();

  // Locator input methods would refocus the textarea and hide a lost caret.
  await page.keyboard.insertText("Follow-up message");
  await expect(composer).toHaveValue("Follow-up message");
  await page.keyboard.press("Shift+Enter");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  expect(
    (await app.snapshot(app.member, room)).messages.map(
      (message) => message.body,
    ),
  ).toEqual([body, "Follow-up message"]);
  expect(sends).toBe(2);
});

test("a delayed keyboard send respects focus moved to conversation search", async ({
  app,
  page,
}) => {
  const room = await app.room("Send then search");
  await app.open(page, app.member, roomPath(room));
  const composer = page.getByRole("textbox", { name: /^Message / });
  const { promise: gate, resolve: release } = deferred();
  const { promise: accepted, resolve: committed } = deferred();
  await page.route(`**${apiPath(room)}/send`, async (route) => {
    const response = await route.fetch();
    committed();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await composer.fill("Send while I search");
    await composer.press("Shift+Enter");
    await accepted;
    await expect(composer).toBeFocused();
    await expect(composer).toHaveAttribute("readonly", "");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Find a phrase" });
    await expect(search).toBeFocused();
    release();
    await expect(composer).toHaveValue("");
    await expect(search).toBeFocused();
    await page.keyboard.insertText("still searching");
    await expect(search).toHaveValue("still searching");
    await expect(composer).toHaveValue("");
  } finally {
    release();
  }
});

for (const touch of [false, true]) {
  test(`composer status preserves input geometry through hints, typing and failures on ${touch ? "touch" : "desktop"}`, async ({
    app,
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      isMobile: touch,
      hasTouch: touch,
      locale: "en-US",
    });
    const peerContext = await browser.newContext();
    try {
      const page = await context.newPage();
      const peer = await peerContext.newPage();
      // Keep the placeholder to one line too; textarea growth from wrapping
      // content is independent of changes to the status footer.
      const room = await app.room("S");
      const ready = new Set<string>();
      for (const [name, view] of [
        ["reader", page],
        ["writer", peer],
      ] as const)
        view.on("websocket", (socket) => {
          if (socket.url().includes("/resources/"))
            socket.on("framereceived", ({ payload }) => {
              if (String(payload).includes('"type":"ready"')) ready.add(name);
            });
        });
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (
            this.name === "drafts" &&
            document.documentElement.dataset.failDraftWrites
          )
            throw new DOMException(
              "Synthetic storage failure",
              "QuotaExceededError",
            );
          return put.apply(this, args);
        };
      });
      await context.addCookies(
        app.member.cookie.split("; ").map((cookie) => {
          const equals = cookie.indexOf("=");
          return {
            name: cookie.slice(0, equals),
            value: cookie.slice(equals + 1),
            url: app.origin,
          };
        }),
      );
      await page.goto(`${app.origin}${roomPath(room)}`);
      const composer = page.getByRole("textbox", { name: /^Message / });
      const footer = page.locator("[data-composer-status]");
      await expect(composer).toBeVisible();
      const gutters = await page
        .locator("[data-composer]")
        .evaluate((frame) => {
          const outer = frame.getBoundingClientRect();
          const form = frame.querySelector("form")!.getBoundingClientRect();
          return {
            left: form.left - outer.left,
            right: outer.right - form.right,
            bottom: outer.bottom - form.bottom,
          };
        });
      expect(gutters.left).toBeGreaterThan(0);
      expect(gutters.right).toBe(gutters.left);
      expect(gutters.bottom).toBe(gutters.left);
      const geometry = await composer.boundingBox();
      const footerGeometry = await footer.boundingBox();
      // The send shortcut is the slot's quiet default on fine pointers and
      // stays until typing or a notice replaces it; touch never shows it.
      const hint = page.getByText("Shift + Enter to send", { exact: true });
      if (touch) await expect(hint).toBeHidden();
      else await expect(hint).toBeVisible();
      expect(await composer.boundingBox()).toEqual(geometry);
      expect(await footer.boundingBox()).toEqual(footerGeometry);

      await app.open(peer, app.owner, roomPath(room));
      await expect.poll(() => ready.size).toBe(2);
      await peer.getByRole("textbox", { name: /^Message / }).fill("Typing");
      await expect(footer).toContainText("Browser Host is typing");
      expect(await composer.boundingBox()).toEqual(geometry);
      await page.bringToFront();

      await page.evaluate(() => {
        document.documentElement.dataset.failDraftWrites = "true";
      });
      await composer.fill("Keep this draft");
      await expect(footer).toContainText(
        "Couldn't save your draft. Keep this tab open.",
      );
      await expect(footer).not.toContainText("is typing");
      // The notice and its recovery action must stay inside the composer,
      // including when only a narrow column remains between toolbar controls.
      const form = await composer.locator("xpath=ancestor::form").boundingBox();
      const notice = await footer.boundingBox();
      expect(form).not.toBeNull();
      expect(notice!.y + notice!.height).toBeLessThan(form!.y + form!.height);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await composer.boundingBox()).toEqual(geometry);
      expect(await footer.boundingBox()).toEqual(footerGeometry);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => {
        delete document.documentElement.dataset.failDraftWrites;
      });
      await footer
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(footer).not.toContainText("Couldn't save your draft");
      await expect
        .poll(() => savedHistory(page, "drafts"))
        .toContain("Keep this draft");
      expect(await composer.boundingBox()).toEqual(geometry);

      let sends = 0;
      await page.route(`**${apiPath(room)}/send`, async (route) => {
        if (++sends > 1) return route.continue();
        await route.fetch();
        await route.abort("failed");
      });
      const send = page.getByRole("button", { name: "Send", exact: true });
      const actionGeometry = await send.boundingBox();
      await composer.press("Shift+Enter");
      const retry = page.getByRole("button", {
        name: "Try sending again",
        exact: true,
      });
      // A transport failure retains this exact command without freezing unrelated work.
      await expect(
        page.getByRole("button", { name: "Reconnect", exact: true }),
      ).toHaveCount(0);
      await expect(retry).toBeEnabled();
      expect(await retry.boundingBox()).toEqual(actionGeometry);
      expect(await composer.boundingBox()).toEqual(geometry);
      await expect(composer).toHaveAttribute("readonly", "");
      await expect(composer).toBeFocused();
      await page.keyboard.insertText("Cannot edit an uncertain send");
      await expect(composer).toHaveValue("Keep this draft");
      await expect(
        page.getByRole("button", { name: "Insert emoji", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Shift+Enter");
      await expect(composer).toHaveValue("");
      await expect(composer).toBeFocused();
      await expect(
        page.getByRole("button", { name: "Insert emoji", exact: true }),
      ).toBeEnabled();
      expect((await app.snapshot(app.member, room)).messages).toHaveLength(1);
      expect(await composer.boundingBox()).toEqual(geometry);
    } finally {
      await context.close();
      await peerContext.close();
    }
  });
}
