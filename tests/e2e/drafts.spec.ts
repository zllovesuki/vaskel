import { deferred } from "@tests/shared/deferred";
import type { Dialog } from "@playwright/test";
import { test, expect, roomPath, apiPath } from "@tests/e2e/fixtures";
import { apiErrorResponse, savedHistory } from "@tests/e2e/helpers";
import {
  acceptShellUpdate,
  controlShell,
  offerShellUpdate,
} from "@tests/e2e/shell-update";

const meme = {
  name: "reaction.gif",
  mimeType: "image/gif",
  buffer: Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
};

test("a missing channel preserves saved drafts and files in its authorized circle", async ({
  app,
  page,
}) => {
  const room = app.circle;
  await app.open(page, app.member, roomPath(room));
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("Keep my work when a room link is wrong");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
  await expect(
    page.getByRole("list", { name: "Files to send" }).getByRole("status"),
  ).toHaveText(/ · Ready$/);
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain("Keep my work when a room link is wrong");
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain('"filename":"reaction.gif"');
  await expect.poll(() => savedHistory(page, "draftFiles")).not.toBe("[]");
  const saved = await savedHistory(page, "drafts");

  await page.goto(
    `${app.origin}/servers/${room.owner.id}/channels/${crypto.randomUUID()}`,
  );
  await expect(
    page.getByRole("heading", { name: "This conversation isn’t available" }),
  ).toBeVisible();
  expect(await savedHistory(page, "drafts")).toBe(saved);
  expect(await savedHistory(page, "draftFiles")).not.toBe("[]");
  expect((await app.snapshot(app.member, room)).kind).toBe("snapshot");

  await page.goto(`${app.origin}${roomPath(room)}`);
  await expect(composer).toHaveValue("Keep my work when a room link is wrong");
  await expect(page.getByText("reaction.gif", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect((await app.snapshot(app.member, room)).messages).toMatchObject([
    {
      body: "Keep my work when a room link is wrong",
      attachments: [
        { filename: "reaction.gif", byteLength: meme.buffer.length },
      ],
    },
  ]);
});

test("drafts and attachments survive navigation and an accepted shell update, and Forward preserves the destination draft", async ({
  app,
  page,
}) => {
  const a = await app.room("Draft A");
  const b = await app.room("Draft B");
  const original = await app.send(app.owner, a, "Forward this with a meme");
  await app.open(page, app.member, roomPath(a));
  await controlShell(page);
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("A unfinished 日本語");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
  await expect(
    page.getByRole("list", { name: "Files to send" }).getByRole("status"),
  ).toHaveText(/ · Ready$/);
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain("A unfinished 日本語");
  await page.locator(`a[href="${roomPath(b)}"]`).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("textbox", {
      name: `Message #${b.name} · Browser Circle`,
      exact: true,
    })
    .fill("B original draft");
  await page.locator(`a[href="${roomPath(a)}"]`).click();
  await expect(composer).toHaveValue("A unfinished 日本語");
  await expect(page.getByText("reaction.gif", { exact: true })).toBeVisible();
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain("A unfinished 日本語");
  await offerShellUpdate(page);
  await acceptShellUpdate(page);
  await expect(composer).toHaveValue("A unfinished 日本語");
  await expect(page.getByText("reaction.gif", { exact: true })).toBeVisible();
  const row = page.locator(
    `[data-timeline-sequence="${original.createdSequence}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Forward", exact: true }).click();
  const picker = page.getByRole("dialog");
  await picker
    .getByRole("combobox", { name: "Send to", exact: true })
    .selectOption(`server:${b.owner.id}`);
  await picker
    .getByRole("combobox", { name: "Room", exact: true })
    .selectOption(b.channelId);
  await picker.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}${roomPath(b)}`);
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("blockquote")).toContainText(
    "Forward this with a meme",
  );
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
  await composer.fill("My reaction");
  const drafts = page.getByRole("combobox", { name: "Drafts", exact: true });
  await drafts.selectOption({ label: "B original draft" });
  await expect(composer).toHaveValue("B original draft");
  await drafts.selectOption({ label: "My reaction" });
  await expect(composer).toHaveValue("My reaction");
  await expect(
    page.getByRole("list", { name: "Files to send" }).getByRole("status"),
  ).toHaveText(/ · Ready$/);
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("B original draft");
  await expect(composer).toBeFocused();
  await page.keyboard.insertText(" continued");
  await expect(composer).toHaveValue("B original draft continued");
  const messages = (await app.snapshot(app.member, b)).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    body: "My reaction",
    quote: { body: "Forward this with a meme" },
    attachments: [{ filename: "reaction.gif" }],
  });
  await page.locator(`a[href="${roomPath(a)}"]`).click();
  await expect(composer).toHaveValue("A unfinished 日本語");
  await expect(page.getByText("reaction.gif", { exact: true })).toBeVisible();
  expect(await savedHistory(page, "drafts")).not.toContain(
    '"body":"Forward this with a meme"',
  );

  await page.locator(`a[href="${roomPath(app.dm)}"]`).click();
  const dmComposer = page.getByRole("textbox", {
    name: `Message ${app.owner.profile.displayName}`,
    exact: true,
  });
  await dmComposer.fill("Keep my DM draft too");
  await page.locator(`a[href="${roomPath(a)}"]`).click();
  await row.hover();
  await row.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Forward", exact: true }).click();
  await picker
    .getByRole("combobox", { name: "Send to", exact: true })
    .selectOption(`conversation:${app.dm.owner.id}`);
  await expect(
    picker.getByRole("combobox", { name: "Room", exact: true }),
  ).toHaveCount(0);
  await picker.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}${roomPath(app.dm)}`);
  await expect(page.getByRole("blockquote")).toContainText(
    "Forward this with a meme",
  );
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dmComposer).toHaveValue("Keep my DM draft too");
  expect((await app.snapshot(app.member, app.dm)).messages).toMatchObject([
    { quote: { body: "Forward this with a meme" } },
  ]);
});

test("an accepted Send with a lost response restores its exact retry after a shell update without resending", async ({
  app,
  page,
}) => {
  const room = await app.room("Saved retry");
  await app.open(page, app.member, roomPath(room));
  await controlShell(page);
  const composer = page.getByRole("textbox", { name: /^Message / });
  const commands: unknown[] = [];
  await page.route(`**${apiPath(room)}/send`, async (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length > 1) return route.continue();
    await route.fetch();
    await route.abort("failed");
  });
  await composer.fill("Send exactly once across reload");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Try sending again", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain('"attempt":{');
  // A failed Send stays local; its uncertain command still needs an explicit exact retry.
  await expect(
    page.getByRole("button", { name: "Reconnect", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try sending again", exact: true }),
  ).toBeEnabled();
  expect(commands).toHaveLength(1);
  await offerShellUpdate(page);
  await acceptShellUpdate(page);
  await expect(
    page.getByRole("button", { name: "Try sending again", exact: true }),
  ).toBeEnabled();
  expect(commands).toHaveLength(1);
  await page
    .getByRole("button", { name: "Try sending again", exact: true })
    .click();
  await expect(composer).toHaveValue("");
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect((await app.snapshot(app.member, room)).messages).toHaveLength(1);
  await expect.poll(() => savedHistory(page, "drafts")).toBe("[]");
});

test("canceling an update unload warning preserves unsaved work and keeps Update now usable", async ({
  app,
  page,
}) => {
  const room = await app.room("Canceled update");
  await app.open(page, app.member, roomPath(room));
  await controlShell(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "drafts")
        throw new DOMException("Synthetic draft quota", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("Keep this unsaved draft after canceling");
  await expect(
    page.getByText("Couldn't save your draft. Keep this tab open.", {
      exact: true,
    }),
  ).toBeVisible();
  await offerShellUpdate(page);
  const action = page.getByRole("button", {
    name: "Update now",
    exact: true,
  });
  await expect(action).toBeVisible();
  // Reading the notice lets both Workbox installation and waiting events run.
  // Clicking immediately can hide duplicate reload callbacks in the PWA helper.
  await page.waitForTimeout(1_000);
  const warnings: string[] = [];
  const dismissWarning = async (dialog: Dialog) => {
    warnings.push(dialog.type());
    await dialog.dismiss();
  };
  page.on("dialog", dismissWarning);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await action.click({ noWaitAfter: true });
    await expect.poll(() => warnings.length).toBe(attempt);
    await expect(page.locator("body")).toHaveAttribute(
      "data-shell-document",
      "before-update",
    );
    await expect(composer).toHaveValue(
      "Keep this unsaved draft after canceling",
    );
    await expect(action).toBeEnabled();
    expect(
      await page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
      ),
    ).toBe(false);
    expect(warnings).toHaveLength(attempt);
  }
  expect(warnings).toEqual(["beforeunload", "beforeunload"]);
  page.off("dialog", dismissWarning);
  // Remove the unsaved work through the real composer before accepting the
  // ordinary-reload fallback. No synthetic beforeunload event is dispatched.
  await composer.fill("");
  await expect(
    page.getByText("Couldn't save your draft. Keep this tab open.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await acceptShellUpdate(page);
  await expect(composer).toHaveValue("");
  expect((await app.snapshot(app.member, room)).messages).toHaveLength(0);
});

test("two tabs keep independent drafts and a manually cleared draft cannot be restored by the other editor", async ({
  app,
  page,
  context,
}) => {
  const room = await app.room("Tab ownership");
  await app.open(page, app.member, roomPath(room));
  const first = page.getByRole("textbox", { name: /^Message / });
  await first.fill("First tab's draft");
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain("First tab's draft");
  const other = await context.newPage();
  try {
    await other.goto(`${app.origin}${roomPath(room)}`);
    const second = other.getByRole("textbox", { name: /^Message / });
    await expect(second).toHaveValue("");
    await expect(
      other.getByText("You have a draft open in another tab.", {
        exact: false,
      }),
    ).toBeVisible();
    await second.fill("Second tab's draft");
    await expect
      .poll(() => savedHistory(other, "drafts"))
      .toContain("Second tab's draft");
    await first.fill("");
    await expect
      .poll(() => savedHistory(page, "drafts"))
      .not.toContain("First tab's draft");
    await expect(first).toHaveValue("");
    await expect(second).toHaveValue("Second tab's draft");
    await other.reload();
    await expect(second).toHaveValue("Second tab's draft");
    expect(await savedHistory(other, "drafts")).not.toContain(
      "First tab's draft",
    );
    await other.getByRole("button", { name: "Send", exact: true }).click();
    await expect(second).toHaveValue("");
    expect(
      (await app.snapshot(app.member, room)).messages.map(
        (message) => message.body,
      ),
    ).toEqual(["Second tab's draft"]);
  } finally {
    await other.close();
  }
});

test("a current owner denial retires saved drafts and files without a late save resurrecting them", async ({
  app,
  page,
}) => {
  const room = await app.room("Draft access");
  await app.open(page, app.member, roomPath(room));
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("Private unfinished work");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
  await expect(
    page.getByRole("list", { name: "Files to send" }).getByRole("status"),
  ).toHaveText(/ · Ready$/);
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain("Private unfinished work");
  // Another tab retired this owner while its broadcast was missed. A stale
  // write must clear live work as well as refusing to resurrect disk content.
  await page.evaluate(
    async ({ accountId, owner }) => {
      await new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("vaskel-local");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const tx = db.transaction(
            ["draftOwners", "drafts", "draftFiles"],
            "readwrite",
          );
          tx.objectStore("draftOwners").put(crypto.randomUUID(), [
            accountId,
            owner.kind,
            owner.id,
          ]);
          tx.objectStore("drafts").clear();
          tx.objectStore("draftFiles").clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    },
    { accountId: app.member.profile.userId, owner: room.owner },
  );
  await composer.fill("A stale edit cannot revive retired work");
  await expect(composer).toHaveValue("");
  await expect.poll(() => savedHistory(page, "drafts")).toBe("[]");
  await composer.fill("New work under current access");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
  await expect(
    page.getByRole("list", { name: "Files to send" }).getByRole("status"),
  ).toHaveText(/ · Ready$/);
  await expect
    .poll(() => savedHistory(page, "drafts"))
    .toContain("New work under current access");
  await page.route(`**${apiPath(room)}/send`, (route) =>
    route.fulfill(apiErrorResponse("FORBIDDEN")),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => savedHistory(page, "drafts")).toBe("[]");
  await expect.poll(() => savedHistory(page, "draftFiles")).toBe("[]");
  expect((await app.snapshot(app.member, room)).messages).toHaveLength(0);
});

test("file storage failure keeps the live draft usable and leaves no partial saved draft", async ({
  app,
  page,
}) => {
  const a = await app.room("Storage pressure");
  const b = await app.room("Other draft");
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "draftFiles")
        throw new DOMException(
          "Synthetic draft-file quota",
          "QuotaExceededError",
        );
      return put.apply(this, args);
    };
  });
  await app.open(page, app.member, roomPath(a));
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill("Keep my work despite quota");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
  await expect(
    page.getByText("Couldn't save your draft. Keep this tab open.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.locator(`a[href="${roomPath(b)}"]`).click();
  await page.locator(`a[href="${roomPath(a)}"]`).click();
  await expect(composer).toHaveValue("Keep my work despite quota");
  await expect(page.getByText("reaction.gif", { exact: true })).toBeVisible();
  expect(await savedHistory(page, "draftFiles")).toBe("[]");
  await expect
    .poll(() => savedHistory(page, "snapshots"))
    .toContain(a.channelId);
});

test("sending in the background and signing out preserve the correct draft lifetimes", async ({
  app,
  page,
}) => {
  const a = await app.room("Sending draft");
  const b = await app.room("Next conversation");
  await app.open(page, app.member, roomPath(a));
  const composer = page.getByRole("textbox", { name: /^Message / });
  const { promise: gate, resolve: release } = deferred();
  const { promise: accepted, resolve: committed } = deferred();
  await page.route(`**${apiPath(a)}/send`, async (route) => {
    const response = await route.fetch();
    committed();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await composer.fill("Send from A");
    await composer.press("Shift+Enter");
    await accepted;
    await page.locator(`a[href="${roomPath(b)}"]`).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await composer.fill("Keep B after A succeeds");
    release();
    await expect
      .poll(() => savedHistory(page, "drafts"))
      .not.toContain("Send from A");
    await expect(composer).toHaveValue("Keep B after A succeeds");
    await expect(composer).toBeFocused();
    await page.getByLabel("Attach files", { exact: true }).setInputFiles(meme);
    await expect(
      page.getByRole("list", { name: "Files to send" }).getByRole("status"),
    ).toHaveText(/ · Ready$/);
    await expect.poll(() => savedHistory(page, "draftFiles")).not.toBe("[]");
    await page
      .getByRole("button", { name: "Account options", exact: true })
      .click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Email", exact: true }),
    ).toBeVisible();
    await expect.poll(() => savedHistory(page, "drafts")).toBe("[]");
    await expect.poll(() => savedHistory(page, "draftFiles")).toBe("[]");
  } finally {
    release();
  }
});
