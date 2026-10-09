import { readyAttachment } from "@tests/helpers/ready-attachment";
import { acceptedMessage as accepted } from "@tests/helpers/messaging";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { drainAttachments } from "@/server/actors/shared/attachments/cleanup";
import type { Principal } from "@/server/domain/principal";

const SEVEN_DAYS = 7 * 24 * 60 * 60_000;

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const id = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  const principal: Principal = {
    userId,
    sessionId: crypto.randomUUID(),
    expiresAt: Date.now() + SEVEN_DAYS * 2,
  };
  await owner.initialize({ serverId: id, name: "GC drill", ownerId: userId });
  const command = () => ({
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    channelId: id,
  });
  const ready = async () =>
    (
      await readyAttachment(owner, principal, {
        ...command(),
        filename: "retained-資料.txt",
        byteLength: 3,
      })
    ).upload;
  const send = async (
    attachmentIds: string[] = [],
    body = "retained 東京資料 body",
  ) =>
    accepted(
      (await owner.send(principal, { ...command(), attachmentIds, body }))
        .outcome,
    );
  const remove = async (messageId: string) =>
    accepted(
      await owner.deleteMessage(principal, {
        ...command(),
        messageId,
        expectedVersion: 1,
      }),
    );
  return { id, owner, principal, ready, send, remove };
}

describe("operational seven-day deletion", () => {
  it("derives eligibility from real deletions and resumes bounded alarm passes after eviction", async () => {
    // Only policy Date.now changes. Future dates keep native automatic alarms from
    // racing the official explicit alarm helper; no fake timers or due-row rewrites.
    const deletedAt = Date.now() + 30 * 24 * 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deletedAt);
    const eligibleAt = deletedAt + SEVEN_DAYS;
    const h = await setup();
    const initial = MessagingOutcomeSchema.parse(
      await h.owner.snapshot(h.principal, { channelId: h.id }),
    );
    if (initial.kind !== "snapshot") throw new Error("Expected snapshot");
    const files: Awaited<ReturnType<typeof h.ready>>[] = [];
    for (let index = 0; index < 201; index++) {
      const file = index < 22 ? await h.ready() : undefined;
      if (file) files.push(file);
      const receipt = await h.send(file ? [file.fileId] : []);
      if (index === 21 && file) {
        expect(
          await h.owner.setAttachmentIncident(
            { ...h.principal, isOperator: true },
            file.fileId,
            {
              quarantined: true,
              preserve: true,
              incidentReference: "restricted-gc-drill",
            },
          ),
        ).toEqual({ kind: "attachment_updated" });
      }
      await h.remove(receipt.messageId);
    }
    const held = files[21]!;
    const eligible = files.slice(0, 21);
    const live = await h.ready();
    const liveMessage = await h.send([live.fileId], "live control");

    const inspect = () =>
      runInDurableObject(h.owner, async (_instance, state) => ({
        bodies: state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM deleted_payloads",
          )
          .one().count,
        owner: state.storage.sql
          .exec(
            "SELECT high_water, replay_floor, attachment_bytes FROM owner_state",
          )
          .one(),
        retired: state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM attachments WHERE state = 'retired' AND preservation_hold = 0",
          )
          .one().count,
        cleaned: state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM attachments WHERE state = 'cleaned'",
          )
          .one().count,
        alarm: await state.storage.getAlarm(),
      }));
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count, MIN(eligible_at) AS first, MAX(eligible_at) AS last FROM deleted_payloads",
          )
          .one(),
      ).toEqual({ count: 201, first: eligibleAt, last: eligibleAt });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count, MIN(cleanup_at) AS first, MAX(cleanup_at) AS last FROM attachments WHERE state = 'retired'",
          )
          .one(),
      ).toEqual({ count: 22, first: eligibleAt, last: eligibleAt });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM deleted_payloads WHERE body = 'retained 東京資料 body'",
          )
          .one(),
      ).toEqual({ count: 201 });
    });

    const assertHidden = async () => {
      let before: number | undefined;
      let tombstones = 0;
      do {
        const page = MessagingOutcomeSchema.parse(
          await h.owner.snapshot(h.principal, {
            channelId: h.id,
            limit: 40,
            ...(before === undefined ? {} : { before }),
          }),
        );
        if (page.kind !== "snapshot") throw new Error(`Snapshot: ${page.kind}`);
        for (const message of page.messages) {
          if (message.id === liveMessage.messageId) continue;
          expect(message).toMatchObject({
            body: null,
            attachments: [],
            deletedAt,
          });
          tombstones++;
        }
        before = page.nextBefore ?? undefined;
      } while (before !== undefined);
      expect(tombstones).toBe(201);
      expect(
        await h.owner.search(h.principal, {
          channelId: h.id,
          query: "東京資料",
        }),
      ).toEqual({ kind: "matches", messages: [] });
      let cursor = initial.cursor;
      let events = 0;
      let hasMore: boolean;
      do {
        const page = MessagingOutcomeSchema.parse(
          await h.owner.replay(h.principal, { channelId: h.id, cursor }),
        );
        if (page.kind !== "replay") throw new Error(`Replay: ${page.kind}`);
        for (const event of page.events) {
          if (event.message.id === liveMessage.messageId) continue;
          expect(event.message).toMatchObject({
            body: null,
            attachments: [],
            deletedAt,
          });
          events++;
        }
        expect(page.highWater).toBe(403);
        cursor = page.cursor;
        hasMore = page.hasMore;
      } while (hasMore);
      expect(events).toBe(402);
      for (const file of files)
        expect(
          await h.owner.authorizeAttachmentDownload(h.principal, file.fileId),
        ).toEqual({ kind: "not_found" });
      expect(
        await h.owner.authorizeAttachmentDownload(h.principal, live.fileId),
      ).toMatchObject({ kind: "attachment_download" });
    };

    clock.mockReturnValue(eligibleAt - 1);
    expect(await runDurableObjectAlarm(h.owner)).toBe(true);
    expect(await inspect()).toEqual({
      bodies: 201,
      retired: 21,
      cleaned: 0,
      owner: { high_water: 403, replay_floor: 0, attachment_bytes: 69 },
      alarm: eligibleAt,
    });
    for (const file of [...files, live]) {
      const object = await env.ATTACHMENTS.get(file.objectKey);
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    }
    await assertHidden();

    clock.mockReturnValue(eligibleAt);
    // At this date each object removal is followed by its due receipt removal:
    // 20 cleanup steps = 10 confirmed R2 deletes, not 20 deletes.
    for (const [pass, remaining] of [11, 1, 0].entries()) {
      expect(await runDurableObjectAlarm(h.owner)).toBe(true);
      expect(await inspect()).toEqual({
        bodies: pass === 0 ? 1 : 0,
        retired: remaining,
        cleaned: 0,
        owner: {
          high_water: 403,
          replay_floor: 0,
          attachment_bytes: (remaining + 2) * 3,
        },
        alarm: remaining ? eligibleAt + 1_000 : null,
      });
      const retained = await Promise.all(
        eligible.map((file) => env.ATTACHMENTS.head(file.objectKey)),
      );
      expect(retained.filter(Boolean)).toHaveLength(remaining);
      if (pass === 0) {
        // Interrupt the drain between alarms and reconstruct the actual actor.
        await evictDurableObject(h.owner);
        expect((await inspect()).alarm).toBe(eligibleAt + 1_000);
      }
    }
    for (const file of [held, live])
      expect(await env.ATTACHMENTS.head(file.objectKey)).not.toBeNull();
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT state, preservation_hold, quarantined FROM attachments WHERE id = ?",
            held.fileId,
          )
          .one(),
      ).toEqual({
        state: "retired",
        preservation_hold: 1,
        quarantined: 1,
      });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM messages WHERE body IS NULL AND deleted_at IS NOT NULL",
          )
          .one(),
      ).toEqual({ count: 201 });
    });
    await assertHidden();
  }, 30_000);

  it("returns at the native five-second work budget while an unconfirmed delete remains charged and durably leased", async () => {
    const deletedAt = Date.now() + 30 * 24 * 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deletedAt);
    const h = await setup();
    const file = await h.ready();
    const message = await h.send([file.fileId]);
    await h.remove(message.messageId);
    const eligibleAt = deletedAt + SEVEN_DAYS;
    clock.mockReturnValue(eligibleAt);
    await runInDurableObject(h.owner, async (_instance, state) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const database = openOwnerDatabase(state.storage);
        const started = performance.now();
        await drainAttachments(state, database, {
          head: env.ATTACHMENTS.head.bind(env.ATTACHMENTS),
          delete: async (key) => {
            await gate;
            await env.ATTACHMENTS.delete(key);
          },
        });
        // Date.now is controlled but setTimeout and performance.now are native.
        const elapsed = performance.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(4_900);
        expect(elapsed).toBeLessThan(7_500);
        expect(
          state.storage.sql
            .exec(
              "SELECT state, deletion_authorized, cleanup_lease_expires_at FROM attachments WHERE id = ?",
              file.fileId,
            )
            .one(),
        ).toEqual({
          state: "retired",
          deletion_authorized: 1,
          cleanup_lease_expires_at: eligibleAt + 30_000,
        });
        expect(
          state.storage.sql
            .exec("SELECT attachment_bytes FROM owner_state")
            .one(),
        ).toEqual({ attachment_bytes: 3 });
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(await env.ATTACHMENTS.head(file.objectKey)).not.toBeNull();
      } finally {
        release();
      }
      // Finish the callback in its originating DO I/O context. Native polling
      // only observes completion; it does not advance policy time or timers.
      await vi.waitFor(() => {
        expect(
          state.storage.sql
            .exec("SELECT state FROM attachments WHERE id = ?", file.fileId)
            .one(),
        ).toEqual({ state: "cleaned" });
      });
    });
    // The next real alarm removes the receipt and body after confirmation.
    expect(await runDurableObjectAlarm(h.owner)).toBe(true);
    expect(await env.ATTACHMENTS.head(file.objectKey)).toBeNull();
    await runInDurableObject(h.owner, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT high_water, attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ high_water: 2, attachment_bytes: 0 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM attachments")
          .one(),
      ).toEqual({ count: 0 });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  }, 15_000);
});
