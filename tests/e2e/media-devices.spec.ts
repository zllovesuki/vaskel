import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type * as Fixture from "@tests/e2e/media-transfer-fixture";
import { test } from "@tests/e2e/native-media-test";

async function startPublisher(
  page: Page,
  origin: string,
  options: Parameters<typeof Fixture.createDeviceProof>[0],
) {
  await page.goto(origin);
  if (options?.inherited) await page.reload();
  await page.evaluate(async (options) => {
    const path = "/media.js";
    const fixture = (await import(path)) as typeof Fixture;
    if (options?.inherited) {
      window.deviceProof = await fixture.createDeviceProof(options);
      return;
    }
    document.querySelector("button")!.addEventListener(
      "click",
      () => {
        void fixture.createDeviceProof(options).then((proof) => {
          window.deviceProof = proof;
        });
      },
      { once: true },
    );
  }, options);
  if (!options?.inherited) await page.getByRole("button").click();
  const state = () => page.evaluate(() => window.deviceProof?.state());
  await expect.poll(async () => Boolean(await state())).toBe(true);
  return state;
}

test("device switching keeps native sender/publication identity and decoded content without offers, with republish fallback", async ({
  page,
  moduleOrigin: origin,
}, testInfo) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = "/media.js";
    const fixture = (await import(path)) as typeof Fixture;
    document.querySelector("button")!.addEventListener(
      "click",
      () => {
        void fixture.createDeviceProof().then((proof) => {
          window.deviceProof = proof;
        });
      },
      { once: true },
    );
  });
  await page.getByRole("button").click();
  const state = () => page.evaluate(() => window.deviceProof?.state());
  const decoded = async (frequency: number, rgb: number[]) => {
    await expect
      .poll(async () => Math.abs(((await state())?.frequency ?? 0) - frequency))
      .toBeLessThan(10);
    await expect
      .poll(async () =>
        (await state())?.rgb.every(
          (value, index) => Math.abs(value - rgb[index]!) < 15,
        ),
      )
      .toBe(true);
  };
  try {
    await decoded(440, [240, 20, 20]);
    const initial = (await state())!;
    const observations = [initial];
    for (const [index, frequency, color] of [
      [1, 880, [20, 240, 20]],
      [2, 660, [20, 20, 240]],
      [3, 990, [240, 240, 20]],
    ] as const) {
      await page.evaluate((index) => window.deviceProof.switch(index), index);
      await decoded(frequency, [...color]);
      const result = (await state())!;
      expect(result.error).toBeNull();
      expect(result.offers).toBe(initial.offers);
      expect(
        result.calls.filter((call) =>
          ["publish", "ack", "unpublish"].includes(call),
        ),
      ).toEqual(
        initial.calls.filter((call) =>
          ["publish", "ack", "unpublish"].includes(call),
        ),
      );
      expect(result.publications).toEqual(initial.publications);
      expect(result.mids).toEqual(initial.mids);
      expect(result.receivers).toEqual(initial.receivers);
      expect(
        result.captures.slice(0, -2).every((state) => state === "ended"),
      ).toBe(true);
      observations.push(result);
    }
    await page.evaluate(() => window.deviceProof.switch(0, true));
    await decoded(440, [240, 20, 20]);
    const fallback = (await state())!;
    expect(fallback.error).toBeNull();
    expect(fallback.offers).toBe(initial.offers + 1);
    expect(fallback.calls.slice(-3)).toEqual(["unpublish", "publish", "ack"]);
    expect(fallback.publications).toHaveLength(2);
    expect(fallback.publications).not.toEqual(initial.publications);
    await testInfo.attach("native-device-replacement", {
      body: JSON.stringify({ observations, fallback }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await testInfo.attach("device-final-state", {
      body: JSON.stringify(await state()),
      contentType: "application/json",
    });
    await page.evaluate(() => window.deviceProof?.close());
  }
});

test("default join captures and publishes the browser microphone automatically", async ({
  page,
  moduleOrigin: origin,
}) => {
  const state = await startPublisher(page, origin, {
    camera: false,
    nativeMicrophone: true,
  });
  try {
    await expect.poll(async () => (await state())?.publications.length).toBe(1);
    expect((await state())!.captureRequests).toBe(1);
    expect((await state())!.muted).toBe(false);
    expect((await state())!.contexts).toEqual([]);
    expect(
      (await state())!.calls.filter((call) => call === "publish"),
    ).toHaveLength(1);
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.deviceProof.rtp()).received),
      )
      .toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => window.deviceProof?.close());
  }
});

test("muted startup sends decoded silence and unmute replaces the same sender", async ({
  page,
  moduleOrigin: origin,
}, testInfo) => {
  const state = await startPublisher(page, origin, {
    camera: false,
    muted: true,
  });
  try {
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.deviceProof.rtp()).samples),
      )
      .toBeGreaterThan(0);
    const initial = (await state())!;
    expect(initial.captureRequests).toBe(0);
    expect(initial.muted).toBe(true);
    expect(initial.contexts).toEqual(["running"]);
    expect(initial.publications).toHaveLength(1);
    expect(initial.local).toEqual([]);
    const observations = [await page.evaluate(() => window.deviceProof.rtp())];
    await expect
      .poll(async () => {
        const current = await page.evaluate(() => window.deviceProof.rtp());
        return (["packets", "bytes", "received", "samples"] as const).every(
          (key) => current[key] > observations[0]![key],
        );
      })
      .toBe(true);
    observations.push(await page.evaluate(() => window.deviceProof.rtp()));
    for (const observation of observations) expect(observation.energy).toBe(0);
    // Opus decoding may dither zero input by one signed 16-bit sample.
    const decodedPeaks = [initial.peak, (await state())!.peak];
    for (const peak of decodedPeaks) expect(peak).toBeLessThan(2 / 32767);
    await page.evaluate(() => {
      window.deviceProof.denyCapture(true);
      window.deviceProof.mute();
    });
    await expect.poll(async () => (await state())!.captureRequests).toBe(1);
    expect((await state())!.muted).toBe(true);
    expect((await state())!.error).not.toBeNull();
    expect((await state())!.publications).toEqual(initial.publications);
    expect((await state())!.senders).toEqual(initial.senders);
    await page.evaluate(() => {
      window.deviceProof.denyCapture(false);
      window.deviceProof.mute();
    });
    await expect
      .poll(async () => Math.abs((await state())!.frequency - 440))
      .toBeLessThan(10);
    const unmuted = (await state())!;
    expect(unmuted.muted).toBe(false);
    expect(unmuted.publications).toEqual(initial.publications);
    expect(unmuted.mids).toEqual(initial.mids);
    expect(unmuted.receivers).toEqual(initial.receivers);
    expect(unmuted.senders?.map(({ id }) => id)).toEqual(
      initial.senders?.map(({ id }) => id),
    );
    expect(unmuted.senders?.map(({ track }) => track)).not.toEqual(
      initial.senders?.map(({ track }) => track),
    );
    expect(unmuted.offers).toBe(initial.offers);
    expect(unmuted.contexts).toEqual(["closed"]);
    await page.evaluate(() => window.deviceProof.mute());
    await expect
      .poll(async () => (await state())!.peak)
      .toBeLessThan(2 / 32767);
    expect((await state())!.captureRequests).toBe(2);
    expect((await state())!.publications).toEqual(initial.publications);
    await page.evaluate(() => window.deviceProof.leave());
    expect((await state())!.captures).toEqual(["ended"]);
    const evidence = testInfo.outputPath("native-muted-startup.json");
    await writeFile(
      evidence,
      JSON.stringify(
        { initial, observations, decodedPeaks, unmuted, final: await state() },
        null,
        2,
      ),
    );
    await testInfo.attach("native-muted-startup", {
      path: evidence,
      contentType: "application/json",
    });
  } finally {
    await page.evaluate(() => window.deviceProof?.close());
  }
});

test("inherited muted startup waits for Enable call audio and Leave disposes its suspended source", async ({
  page,
  moduleOrigin: origin,
}) => {
  const state = await startPublisher(page, origin, {
    camera: false,
    muted: true,
    suspended: true,
    inherited: true,
  });
  try {
    await expect.poll(async () => (await state())!.blocked).toBe(true);
    expect((await state())!.contexts).toEqual(["suspended"]);
    expect((await state())!.captureRequests).toBe(0);
    expect((await state())!.calls).toContain("resume");
    expect((await state())!.calls).not.toContain("join");
    expect((await state())!.publications).toEqual([]);
    await page.evaluate(() => {
      const button = document.querySelector("button")!;
      button.textContent = "Enable call audio";
      button.addEventListener("click", () => window.deviceProof.enableAudio(), {
        once: true,
      });
    });
    await page.getByRole("button", { name: "Enable call audio" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.deviceProof.rtp()).received),
      )
      .toBeGreaterThan(0);
    await expect.poll(async () => (await state())!.blocked).toBe(false);
    expect((await state())!.contexts).toEqual(["running"]);
    await page.evaluate(() => window.deviceProof.leave());
    expect((await state())!.contexts).toEqual(["closed"]);
  } finally {
    await page.evaluate(() => window.deviceProof?.close());
  }
});

test("Leave before audio activation prevents a suspended source from publishing later", async ({
  page,
  moduleOrigin: origin,
}) => {
  const state = await startPublisher(page, origin, {
    camera: false,
    muted: true,
    suspended: true,
  });
  try {
    await expect.poll(async () => (await state())!.blocked).toBe(true);
    await page.evaluate(() => window.deviceProof.leave());
    expect((await state())!.contexts).toEqual(["closed"]);
    await page.evaluate(() => window.deviceProof.enableAudio());
    await expect.poll(async () => (await state())!.blocked).toBe(false);
    expect((await state())!.phase).toBe("idle");
    expect((await state())!.captureRequests).toBe(0);
    expect((await state())!.calls).not.toContain("publish");
  } finally {
    await page.evaluate(() => window.deviceProof?.close());
  }
});
