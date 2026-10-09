import { expect, type Page } from "@playwright/test";
import type * as Fixture from "@tests/e2e/media-transfer-fixture";
import { test } from "@tests/e2e/native-media-test";

async function startListener(page: Page, origin: string, reuseMids = false) {
  await page.goto(origin);
  await page.evaluate(async (reuseMids) => {
    const path = "/media.js";
    const fixture = (await import(path)) as typeof Fixture;
    document.querySelector("button")!.addEventListener(
      "click",
      () => {
        void fixture.createMediaProof(reuseMids).then((proof) => {
          window.mediaProof = proof;
        });
      },
      { once: true },
    );
  }, reuseMids);
  await page.getByRole("button", { name: "Start listener" }).click();
  const state = () => page.evaluate(() => window.mediaProof?.state());
  const playing = async (generation: number) => {
    await expect
      .poll(async () =>
        (await state())?.playback
          .filter(
            (element) =>
              element.attached &&
              !element.paused &&
              element.ready >= 2 &&
              element.time > 0,
          )
          .map((element) => element.label)
          .sort(),
      )
      .toEqual([
        `${generation}:camera`,
        `${generation}:microphone`,
        `${generation}:screen_audio`,
        `${generation}:screen_video`,
      ]);
  };
  return { state, playing };
}

test("a listener detaches retired audio/video while old RTP flows and late offers, tracks and snapshots arrive", async ({
  page,
  moduleOrigin: origin,
}, testInfo) => {
  const { state, playing } = await startListener(page, origin);
  try {
    await playing(1);
    await expect.poll(async () => (await state())?.connected).toBe("connected");
    await page.evaluate(() => window.mediaProof.advance(2));
    await playing(2);
    // Transport retirement never occurs: obsolete RTP is still actively sent.
    const oldBytes = await page.evaluate(() => window.mediaProof.bytes(1));
    await expect
      .poll(() => page.evaluate(() => window.mediaProof.bytes(1)))
      .toBeGreaterThan(oldBytes);
    expect(
      (await state())!.senders
        .filter((sender) => sender.generation === 1)
        .every((sender) => sender.state === "live"),
    ).toBe(true);

    await page.evaluate(() => {
      window.mediaProof.hold();
      window.mediaProof.advance(3);
    });
    await expect.poll(async () => (await state())!.held).toBe(true);
    await expect(page.locator("audio, video")).toHaveCount(0);
    // A newer snapshot overtakes a real SDP offer while that response is held.
    await page.evaluate(() => {
      window.mediaProof.advance(4);
      window.mediaProof.lateTrack(1);
      window.mediaProof.staleSnapshot(1);
    });
    expect(
      (await state())!.requests.some((request) => request.includes(4)),
    ).toBe(false);
    await page.evaluate(() => window.mediaProof.release());
    await playing(4);
    await page.evaluate(() => {
      window.mediaProof.lateTrack(2);
      window.mediaProof.lateTrack(3);
      window.mediaProof.staleSnapshot(2);
    });
    await playing(4);
    const result = (await state())!;
    await testInfo.attach("native-media-observation", {
      body: JSON.stringify(
        {
          ...result,
          obsoleteBytesBefore: oldBytes,
          obsoleteBytesAfter: await page.evaluate(() =>
            window.mediaProof.bytes(1),
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(result.failures).toEqual([]);
    const finalReplacement = result.events.findIndex(
      (event) => event.action === "attach" && event.generation === 4,
    );
    expect(finalReplacement).toBeGreaterThan(0);
    expect(
      result.events
        .slice(finalReplacement)
        .filter((event) => event.action === "attach" && event.generation !== 4),
    ).toEqual([]);
    expect(result.roster).toBe(1);
    expect(result.revision).toBe(4);
    expect(result.events.filter((event) => event.attached.length > 1)).toEqual(
      [],
    );
    expect(
      result.events.filter(
        (event) => event.action === "attach" && event.generation === 3,
      ),
    ).toEqual([]);
    const firstReplacement = result.events.findIndex(
      (event) => event.action === "attach" && event.generation === 2,
    );
    expect(firstReplacement).toBeGreaterThan(0);
    expect(
      result.events
        .slice(0, firstReplacement)
        .some(
          (event) => event.action === "detach" && event.attached.length === 0,
        ),
    ).toBe(true);
    expect(
      result.events
        .slice(firstReplacement)
        .filter((event) => event.action === "attach" && event.generation === 1),
    ).toEqual([]);
  } finally {
    await page.evaluate(() => window.mediaProof?.close());
  }
});

test("replacement can reuse native receiver MIDs after the old playback stream is detached", async ({
  page,
  moduleOrigin: origin,
}) => {
  const { state, playing } = await startListener(page, origin, true);
  try {
    await playing(1);
    const before = (await state())!.receivers;
    expect(before).toHaveLength(4);
    await page.evaluate(() => window.mediaProof.advance(2));
    await playing(2);
    const after = (await state())!;
    // Real RTCRtpReceivers retain their original track identity across this SDP update.
    expect(after.receivers).toEqual(before);
    expect(after.receivers.every((receiver) => receiver.state === "live")).toBe(
      true,
    );
    expect(after.events.filter((event) => event.attached.length > 1)).toEqual(
      [],
    );
    expect(after.failures).toEqual([]);
  } finally {
    await page.evaluate(() => window.mediaProof?.close());
  }
});
