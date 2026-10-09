import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { uploadAttachment } from "@/server/files/upload";
import { blockingPair, blockCommand } from "@tests/helpers/blocking-harness";

it("settles and retires a real R2 writer blocked during PUT, without reviving it after unblock", async ({
  onTestFinished,
}) => {
  // Observe retirement before the test explicitly runs its native cleanup alarm.
  const now = Date.now() + 30 * 24 * 60 * 60_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  onTestFinished(() => {
    clock.mockRestore();
  });
  const h = await blockingPair();
  const file = await h.reserve();
  let entered!: () => void;
  let release!: () => void;
  const putEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const putReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending: Promise<unknown>[] = [];
  let objectKey: string | undefined;
  const upload = uploadAttachment(
    new Request("https://vaskel.test/upload", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    }),
    {
      put: async (key, body, options) => {
        objectKey = key;
        const object = await env.ATTACHMENTS.put(key, body, options);
        entered();
        await putReleased;
        return object;
      },
    },
    h.owner,
    h.alice,
    file.fileId,
    async () => h.alice,
    (work) => pending.push(work),
  );
  await putEntered;
  expect(
    await h.owner.setBlock(h.bob, h.alice.userId, blockCommand()),
  ).toMatchObject({ kind: "block_updated" });
  release();
  expect(await upload).toEqual({ kind: "dm_blocked" });
  await Promise.all(pending);
  await runInDurableObject(h.owner, (_instance, state) => {
    expect(
      state.storage.sql
        .exec(
          "SELECT state, writer_state, outstanding FROM attachments WHERE id = ?",
          file.fileId,
        )
        .one(),
    ).toEqual({
      state: "retired",
      writer_state: "settled",
      outstanding: 1,
    });
    expect(
      state.storage.sql
        .exec("SELECT high_water, attachment_bytes FROM owner_state")
        .one(),
    ).toEqual({ high_water: 0, attachment_bytes: 3 });
  });
  await h.owner.setBlock(h.bob, h.alice.userId, blockCommand(false, 1));
  expect(
    (await h.owner.send(h.alice, h.send("", [file.fileId]))).outcome,
  ).toEqual({
    kind: "attachment_expired",
  });
  await runDurableObjectAlarm(h.owner);
  expect(objectKey).toBeDefined();
  expect(await env.ATTACHMENTS.head(objectKey!)).toBeNull();
  await runInDurableObject(h.owner, (_instance, state) => {
    expect(
      state.storage.sql
        .exec(
          "SELECT state, outstanding FROM attachments WHERE id = ?",
          file.fileId,
        )
        .one(),
    ).toEqual({ state: "cleaned", outstanding: 0 });
    expect(
      state.storage.sql.exec("SELECT attachment_bytes FROM owner_state").one(),
    ).toEqual({ attachment_bytes: 0 });
  });
});
