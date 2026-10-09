import { test, expect, roomPath } from "@tests/e2e/fixtures";
import {
  acceptShellUpdate,
  controlShell,
  offerShellUpdate,
} from "@tests/e2e/shell-update";
import { syntheticMedia } from "@tests/e2e/media-ui-fixture";

test("a shell update waits for acceptance, then resumes the muted call without recapturing camera or screen", async ({
  app,
  page,
}) => {
  const room = await app.room("Accepted update call", "media");
  const media = await syntheticMedia(page, app, app.member, room, "joined");
  await page.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const count = (source: string) => {
      const key = `update-test:capture:${source}`;
      sessionStorage.setItem(
        key,
        String(Number(sessionStorage.getItem(key) ?? 0) + 1),
      );
    };
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints?.audio) count("microphone");
      if (constraints?.video) count("camera");
      return capture(constraints);
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      count("screen");
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      canvas.getContext("2d")!.fillRect(0, 0, 640, 360);
      return canvas.captureStream(5);
    };
  });
  await app.open(page, app.member, roomPath(room));
  await controlShell(page);
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop camera", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toBeVisible();
  const intentKey = `vaskel:call:${app.origin}:${app.member.profile.userId}`;
  const intent = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)!),
    intentKey,
  );
  const captures = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ["microphone", "camera", "screen"].map((source) => [
          source,
          Number(sessionStorage.getItem(`update-test:capture:${source}`) ?? 0),
        ]),
      ),
    );
  expect(await captures()).toEqual({ microphone: 0, camera: 1, screen: 1 });
  const controller = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL,
  );
  expect(controller).toBe(`${app.origin}/sw.js`);
  await offerShellUpdate(page);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
  ).toBe(controller);
  await expect(page.locator("body")).toHaveAttribute(
    "data-shell-document",
    "before-update",
  );
  await expect(
    page.getByRole("button", { name: "Picture in picture", exact: true }),
  ).toBeVisible();
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  expect(media.unexpected).toEqual([]);
  await acceptShellUpdate(page);
  await expect.poll(() => media.resumes.length).toBe(1);
  expect(media.resumes[0]!.handle).toEqual(intent.handle);
  expect(media.resumes[0]!.nextDeviceToken).not.toBe(intent.handle.deviceToken);
  await expect(
    page.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Camera", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Stop camera", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toHaveCount(0);
  expect(await captures()).toEqual({ microphone: 0, camera: 1, screen: 1 });
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(`${key}:muted`),
      intentKey,
    ),
  ).toBe("true");
  const resumedIntent = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)!),
    intentKey,
  );
  expect(resumedIntent.room).toEqual(intent.room);
  expect(resumedIntent.handle.deviceToken).toBe(
    media.resumes[0]!.nextDeviceToken,
  );
  expect(media.joins).toHaveLength(1);
  expect(media.leaves).toHaveLength(0);
  expect(media.unexpected).toEqual([]);
});
