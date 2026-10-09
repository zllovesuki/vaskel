import { readyAttachment } from "@tests/helpers/ready-attachment";
import { acceptedMessage as accepted } from "@tests/helpers/messaging";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AttachmentOutcomeSchema } from "@vaskel/contracts/attachments";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { drainAttachments } from "@/server/actors/shared/attachments/cleanup";
import { refreshOwnerAlarm } from "@/server/actors/shared/maintenance";
import { setAttachmentIncident } from "@/server/actors/shared/attachments/commands";
import { storageObservation } from "@/server/actors/shared/attachments/types";
import type { Principal } from "@/server/domain/principal";

const principal = (): Principal => ({
  userId: "alice",
  sessionId: "session-alice",
  expiresAt: Date.now() + 60_000,
});
async function setup() {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({ serverId: id, name: "Files", ownerId: "alice" });
  const reserve = async (filename = "資料.txt", byteLength = 3) => {
    const command = {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      channelId: id,
      filename,
      byteLength,
    };
    const result = AttachmentOutcomeSchema.parse(
      await owner.reserveAttachment(principal(), command),
    );
    if (result.kind !== "attachment_reserved")
      throw new Error(`Reserve: ${result.kind}`);
    return { ...result, command };
  };
  const begin = async (fileId: string) => {
    const result = await owner.beginAttachmentUpload(principal(), fileId);
    if (result.kind !== "attachment_upload")
      throw new Error(`Begin: ${result.kind}`);
    return result.upload;
  };
  const ready = (filename = "資料.txt") =>
    readyAttachment(owner, principal(), {
      channelId: id,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      filename,
      byteLength: 3,
    });
  const send = (attachmentIds: string[], body = "") => ({
    channelId: id,
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    body,
    attachmentIds,
  });
  return { id, owner, reserve, begin, ready, send };
}

describe("owner attachment transactions and bounded liability", () => {
  it("rolls cleanup accounting back and preserves reservation recovery after releasing a never-started writer", async () => {
    const h = await setup();
    const file = await h.reserve();
    await runInDurableObject(h.owner, async (_instance, state) => {
      const database = openOwnerDatabase(state.storage);
      state.storage.sql.exec(
        "CREATE TRIGGER fail_attachment_cleanup BEFORE UPDATE OF state ON attachments WHEN NEW.state = 'cleaned' BEGIN SELECT RAISE(ABORT, 'cleanup receipt failure'); END",
      );
      state.storage.sql.exec(
        "UPDATE attachments SET deadline = 0 WHERE id = ?",
        file.fileId,
      );
      await expect(
        drainAttachments(state, database, env.ATTACHMENTS),
      ).rejects.toThrow("cleanup receipt failure");
      expect(
        state.storage.sql
          .exec(
            "SELECT state, writer_state, outstanding FROM attachments WHERE id = ?",
            file.fileId,
          )
          .one(),
      ).toEqual({
        state: "retired",
        writer_state: "never_started",
        outstanding: 1,
      });
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 3 });
      state.storage.sql.exec("DROP TRIGGER fail_attachment_cleanup");
      await drainAttachments(state, database, env.ATTACHMENTS);
      expect(
        state.storage.sql
          .exec(
            "SELECT state, outstanding, filename, object_key FROM attachments WHERE id = ?",
            file.fileId,
          )
          .one(),
      ).toEqual({
        state: "cleaned",
        outstanding: 0,
        filename: null,
        object_key: null,
      });
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 0 });
    });
    expect(await h.owner.reserveAttachment(principal(), file.command)).toEqual({
      kind: "attachment_reserved",
      fileId: file.fileId,
      expiresAt: file.expiresAt,
    });
    await h.reserve("another.txt");
    await runInDurableObject(h.owner, async (_instance, state) => {
      await drainAttachments(
        state,
        openOwnerDatabase(state.storage),
        env.ATTACHMENTS,
      );
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 3 });
    });
  });

  it("preserves text receipt recovery and allocates one bounded writer", async () => {
    const h = await setup();
    const command = h.send([], "Existing retained message");
    const receipt = accepted(
      (await h.owner.send(principal(), command)).outcome,
    );
    const { attachmentIds: _files, ...withoutFiles } = command;
    expect(
      accepted((await h.owner.send(principal(), withoutFiles)).outcome),
    ).toEqual(receipt);
    expect(
      accepted((await h.owner.send(principal(), command)).outcome),
    ).toEqual(receipt);
    const file = await h.reserve();
    expect(
      await h.owner.reserveAttachment(principal(), file.command),
    ).toMatchObject({ fileId: file.fileId });
    expect(
      await h.owner.reserveAttachment(principal(), {
        ...file.command,
        filename: "changed.txt",
      }),
    ).toEqual({ kind: "command_conflict" });
    const begins = await Promise.all([
      h.owner.beginAttachmentUpload(principal(), file.fileId),
      h.owner.beginAttachmentUpload(principal(), file.fileId),
    ]);
    expect(begins.map((result) => result.kind).sort()).toEqual([
      "attachment_upload",
      "upload_in_progress",
    ]);
    expect(await h.owner.cancelAttachment(principal(), file.fileId)).toEqual({
      kind: "attachment_canceled",
    });
    await runDurableObjectAlarm(h.owner); // A missing HEAD cannot settle that writer.
    for (let index = 0; index < 7; index++) await h.reserve();
    expect(
      await h.owner.reserveAttachment(principal(), {
        ...file.command,
        commandId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "capacity" });
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
        writer_state: "unresolved",
        outstanding: 1,
      });
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 1 });
    });
  });

  it("rolls every claim back after a receipt failure, recovers duplicate sends and serializes cancel/send", async () => {
    const h = await setup();
    const first = await h.ready();
    const second = await h.ready("second.txt");
    const command = h.send([first.fileId, second.fileId]);
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER injected_attachment_failure AFTER INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'injected attachment receipt failure'); END",
      );
    });
    await expect(
      (async () => (await h.owner.send(principal(), command)).outcome)(),
    ).rejects.toThrow(/injected/);
    await runInDurableObject(h.owner, (_instance, state) => {
      for (const table of [
        "messages",
        "message_fts",
        "events",
        "command_receipts",
      ])
        expect(
          state.storage.sql
            .exec(`SELECT COUNT(*) AS count FROM ${table}`)
            .one(),
        ).toEqual({ count: 0 });
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 0 });
      expect(
        state.storage.sql
          .exec("SELECT state, message_id, outstanding FROM attachments")
          .toArray(),
      ).toEqual([
        { state: "ready", message_id: null, outstanding: 1 },
        { state: "ready", message_id: null, outstanding: 1 },
      ]);
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 6 });
      state.storage.sql.exec("DROP TRIGGER injected_attachment_failure");
    });
    const results = await Promise.all([
      h.owner.send(principal(), command).then(({ outcome }) => outcome),
      h.owner.send(principal(), command).then(({ outcome }) => outcome),
    ]);
    const receipt = accepted(results[0]);
    expect(accepted(results[1])).toEqual(receipt);
    expect(await h.owner.cancelAttachment(principal(), first.fileId)).toEqual({
      kind: "attachment_claimed",
      messageId: receipt.messageId,
    });
    expect(
      (
        await h.owner.send(principal(), {
          ...command,
          attachmentIds: [second.fileId, first.fileId],
        })
      ).outcome,
    ).toEqual({ kind: "command_conflict" });
    const canceled = await h.ready("canceled.txt");
    await h.owner.cancelAttachment(principal(), canceled.fileId);
    expect(
      (await h.owner.send(principal(), h.send([canceled.fileId]))).outcome,
    ).toEqual({
      kind: "attachment_expired",
    });
    const edit = {
      ...h.send([]),
      messageId: receipt.messageId,
      expectedVersion: 1,
    };
    expect(await h.owner.edit(principal(), edit)).toMatchObject({
      kind: "accepted",
    });
    expect(
      await h.owner.snapshot(principal(), { channelId: h.id }),
    ).toMatchObject({
      messages: [
        {
          body: "",
          attachments: [{ fileId: first.fileId }, { fileId: second.fileId }],
        },
      ],
      cursor: { sequence: 2 },
    });
  });

  it("retains an absent unresolved key across eviction and removes its late object without touching live files", async () => {
    const h = await setup();
    const live = await h.ready("live.txt");
    accepted((await h.owner.send(principal(), h.send([live.fileId]))).outcome);
    const late = await h.reserve();
    const upload = await h.begin(late.fileId);
    await h.owner.cancelAttachment(principal(), late.fileId);
    await runDurableObjectAlarm(h.owner);
    await evictDurableObject(h.owner);
    await runInDurableObject(h.owner, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ cleanup_at: number; writer_state: string }>(
          "SELECT cleanup_at, writer_state FROM attachments WHERE id = ?",
          late.fileId,
        )
        .one();
      expect(row.writer_state).toBe("unresolved");
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 6 });
      expect(row.cleanup_at).toBeGreaterThan(Date.now() + 30 * 60_000);
    });
    const object = await env.ATTACHMENTS.put(
      upload.objectKey,
      new Uint8Array([4, 5, 6]),
      {
        customMetadata: {
          fileId: upload.fileId,
          generation: upload.generation,
        },
      },
    );
    if (!object) throw new Error("Missing object");
    // No successful Worker callback is needed; owner HEAD discovers its recorded writer.
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachments SET cleanup_at = 0 WHERE id = ? AND state = 'retired'",
        late.fileId,
      );
    });
    await runDurableObjectAlarm(h.owner);
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT writer_state FROM attachments WHERE id = ?",
            late.fileId,
          )
          .one(),
      ).toEqual({ writer_state: "settled" });
      // Reconciliation may already have deleted bytes in this alarm pass.
      // Advance only pending cleanup, preserving a cleaned receipt's retention date.
      state.storage.sql.exec(
        "UPDATE attachments SET cleanup_at = 0 WHERE id = ? AND state = 'retired'",
        late.fileId,
      );
    });
    await runDurableObjectAlarm(h.owner);
    // The HEAD pass schedules a near-immediate alarm. That automatic pass may
    // own the DELETE lease while the forced pass returns without claiming it.
    // Await durable completion, not the completion of one particular alarm.
    await expect
      .poll(
        () =>
          runInDurableObject(
            h.owner,
            (_instance, state) =>
              state.storage.sql
                .exec("SELECT state FROM attachments WHERE id = ?", late.fileId)
                .one().state,
          ),
        { timeout: 2_000 },
      )
      .toBe("cleaned");
    expect(await env.ATTACHMENTS.head(upload.objectKey)).toBeNull();
    expect(await env.ATTACHMENTS.head(live.upload.objectKey)).not.toBeNull();
    expect(
      await h.owner.completeAttachmentUpload(principal(), upload, {
        kind: "stored",
        object: storageObservation(object),
      }),
    ).toEqual({ kind: "attachment_expired" });
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 3 });
      expect(
        state.storage.sql
          .exec(
            "SELECT state, outstanding, object_key FROM attachments WHERE id = ?",
            late.fileId,
          )
          .one(),
      ).toEqual({
        state: "cleaned",
        outstanding: 0,
        object_key: null,
      });
    });
  });

  it("honors preservation before deletion, rejects a late hold and keeps the shared wakeup during failed cleanup", async ({
    onTestFinished,
  }) => {
    // Keep native alarms in the future so only the explicit helper runs cleanup.
    const now = Date.now() + 30 * 24 * 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => {
      clock.mockRestore();
    });
    const h = await setup();
    const file = await h.ready();
    const receipt = accepted(
      (await h.owner.send(principal(), h.send([file.fileId]))).outcome,
    );
    accepted(
      await h.owner.deleteMessage(principal(), {
        ...h.send([]),
        messageId: receipt.messageId,
        expectedVersion: 1,
      }),
    );
    const incident = {
      quarantined: true,
      preserve: true,
      incidentReference: "restricted-fixture-incident",
    };
    expect(
      await h.owner.setAttachmentIncident(
        { ...principal(), isOperator: true },
        file.fileId,
        incident,
      ),
    ).toEqual({ kind: "attachment_updated" });
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachments SET cleanup_at = 0 WHERE id = ?",
        file.fileId,
      );
    });
    await runDurableObjectAlarm(h.owner);
    expect(await env.ATTACHMENTS.head(file.upload.objectKey)).not.toBeNull();
    await h.owner.setAttachmentIncident(
      { ...principal(), isOperator: true },
      file.fileId,
      { ...incident, preserve: false },
    );
    await runInDurableObject(h.owner, async (_instance, state) => {
      const database = openOwnerDatabase(state.storage);
      await drainAttachments(state, database, {
        head: env.ATTACHMENTS.head.bind(env.ATTACHMENTS),
        delete: async () => {
          throw new Error("fixture R2 unavailable");
        },
      });
      expect(
        state.storage.sql
          .exec(
            "SELECT state, cleanup_error FROM attachments WHERE id = ?",
            file.fileId,
          )
          .one(),
      ).toEqual({
        state: "retired",
        cleanup_error: "storage_unavailable",
      });
    });
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachments SET cleanup_at = 0 WHERE id = ?",
        file.fileId,
      );
    });
    await runInDurableObject(h.owner, async (_instance, state) => {
      const database = openOwnerDatabase(state.storage);
      await drainAttachments(state, database, {
        head: env.ATTACHMENTS.head.bind(env.ATTACHMENTS),
        delete: async (key) => {
          expect(
            await setAttachmentIncident(
              state.storage,
              database,
              { ...principal(), isOperator: true },
              file.fileId,
              incident,
            ),
          ).toEqual({ kind: "attachment_expired" });
          expect(await state.storage.getAlarm()).not.toBeNull();
          await env.ATTACHMENTS.delete(key);
        },
      });
      await refreshOwnerAlarm(state, database);
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 0 });
    });
    expect(await env.ATTACHMENTS.head(file.upload.objectKey)).toBeNull();
  });
});
