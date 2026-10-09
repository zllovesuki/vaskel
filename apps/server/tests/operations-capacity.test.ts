import { readHttpFailure } from "@tests/helpers/http";
import { acceptedMessage as accepted } from "@tests/helpers/messaging";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  OwnerCapacityOutcomeSchema,
  OwnerCapacitySchema,
  OWNER_SQL_MIN_BUDGET_BYTES,
} from "@vaskel/contracts/capacity";
import { AttachmentOutcomeSchema } from "@vaskel/contracts/attachments";
import { ResourceCreatedSchema } from "@vaskel/contracts/directory";
import {
  MessageBodySchema,
  type Receipt,
  type SendMessage,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";
import { ownerSqlBudgetBytes } from "@/server/actors/shared/capacity";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { mutateMessage } from "@/server/actors/shared/messages";
import { searchMessages } from "@/server/actors/shared/synchronization";
import { observeSql, selectStatements } from "@tests/helpers/sql-observer";
import { attachmentHarness } from "@tests/helpers/attachment-harness";
import {
  applicationHarness,
  applicationSocket,
  messageCommand,
  resourcePath,
} from "@tests/helpers/application-harness";

function principal(userId = "capacity-owner"): Principal {
  return {
    userId,
    sessionId: `session-${userId}`,
    expiresAt: Date.now() + 60 * 60_000,
  };
}

type Owner = DurableObjectStub<
  import("@/server/actors/server/server-do").ServerDO
>;
async function counts(owner: Owner) {
  return runInDurableObject(owner, (_instance, ctx) => ({
    usedBytes: ctx.storage.sql.databaseSize,
    ...ctx.storage.sql
      .exec<{
        highWater: number;
        messages: number;
        receipts: number;
        attachments: number;
        chargedBytes: number;
      }>(
        `SELECT high_water AS highWater, attachment_bytes AS chargedBytes,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM command_receipts) AS receipts,
      (SELECT COUNT(*) FROM attachments) AS attachments FROM owner_state`,
      )
      .one(),
  }));
}
const largeBody = (index: number) =>
  MessageBodySchema.parse(
    `${index} ` +
      "東京都 数据库設計 데이터베이스 🌿🪷🧵 alpha beta gamma. ".repeat(90),
  );

describe("owner SQL capacity on native workerd storage", () => {
  it.skipIf(env.OWNER_SQL_BUDGET_BYTES !== String(OWNER_SQL_MIN_BUDGET_BYTES))(
    "pauses real growth while recovering receipts and preserving headroom operations",
    async ({ task }) => {
      const h = attachmentHarness();
      const operator = await h.bootstrap();
      const server = await h.createServer(operator);
      const member = await h.registerMember(operator, server.owner.id);
      const owner = env.SERVER_DO.getByName(server.owner.id);
      const p = principal(operator.profile!.userId);
      const memberPrincipal = principal(member.member.profile!.userId);
      const invitation = await h.invite(operator, server.owner.id, 10);
      const registration = {
        token: invitation.token,
        registrationId: crypto.randomUUID(),
        userId: "reserved-member",
      };
      const reservedRegistration =
        await owner.authorizeRegistration(registration);
      expect(reservedRegistration.kind).toBe("registration_authorized");
      const privateChannel = crypto.randomUUID();
      expect(
        await owner.createChannel(p, {
          channelId: privateChannel,
          name: "private fixture",
          private: true,
          expectedVersion: 2,
        }),
      ).toMatchObject({ kind: "changed" });
      const live = await h.upload(
        operator,
        server.path,
        server.channelId,
        "live.txt",
        new Uint8Array([1, 2, 3]),
      );
      const ready = await h.upload(
        operator,
        server.path,
        server.channelId,
        "draft.txt",
        new Uint8Array([4, 5, 6, 7]),
      );
      const pending = await h.reserve(
        operator,
        server.path,
        server.channelId,
        "pending.txt",
        5,
      );
      const canceled = await h.reserve(
        operator,
        server.path,
        server.channelId,
        "cancel.txt",
        6,
      );
      const original: SendMessage = {
        ...messageCommand(server.channelId, "東京都 preserved file"),
        attachmentIds: [live.fileId],
      };
      const originalResult = (await owner.send(p, original)).outcome;
      const originalReceipt = accepted(originalResult);
      const edit = {
        ...messageCommand(server.channelId, "東京都 edited file"),
        messageId: originalReceipt.messageId,
        expectedVersion: 1,
      };
      const edited = accepted(await owner.edit(p, edit));
      const initial = OwnerCapacitySchema.parse(await owner.capacity(p));
      expect(initial.sql).toMatchObject({
        status: "normal",
        budgetBytes: OWNER_SQL_MIN_BUDGET_BYTES,
      });
      expect(initial.attachments.chargedBytes).toBe(18);
      const pauseBytes = initial.sql.pauseBytes;
      let observedWarning = false;
      let progress = await counts(owner);
      let sends = 0;
      // Every byte is populated through message + FTS + receipt production writes.
      while (progress.usedBytes < pauseBytes - 64 * 1_024 && sends < 1_000) {
        accepted(
          (
            await owner.send(
              p,
              messageCommand(server.channelId, largeBody(sends++)),
            )
          ).outcome,
        );
        progress = await counts(owner);
        if (
          progress.usedBytes >= initial.sql.warningBytes &&
          !observedWarning
        ) {
          expect(
            OwnerCapacitySchema.parse(await owner.capacity(p)).sql.status,
          ).toBe("warning");
          observedWarning = true;
        }
      }
      expect(observedWarning).toBe(true);
      expect(progress.usedBytes).toBeLessThan(pauseBytes);
      const beforeRace = progress;
      const race = Array.from({ length: 16 }, (_, index) =>
        messageCommand(server.channelId, largeBody(sends + index)),
      );
      const results = await Promise.all(
        race.map((command) =>
          owner.send(p, command).then(({ outcome }) => outcome),
        ),
      );
      const committed = results.filter((result) => result.kind === "accepted");
      const rejected = results.filter(
        (result) => result.kind === "storage_capacity",
      );
      expect(committed.length).toBeGreaterThan(0);
      expect(rejected.length).toBeGreaterThan(0);
      expect(committed.length + rejected.length).toBe(race.length);
      const paused = await counts(owner);
      expect(paused.highWater).toBe(beforeRace.highWater + committed.length);
      expect(paused.receipts).toBe(beforeRace.receipts + committed.length);
      expect(paused.messages).toBe(beforeRace.messages + committed.length);
      const summary = OwnerCapacitySchema.parse(await owner.capacity(p));
      expect(summary.sql.status).toBe("paused");
      expect(summary.sql.usedBytes).toBeGreaterThanOrEqual(pauseBytes);
      const headroomSamples = [paused.usedBytes];
      const newSend = {
        ...messageCommand(server.channelId, "retained draft"),
        attachmentIds: [ready.fileId],
      };
      const denied = await operator.request(`${server.path}/send`, newSend);
      expect(denied.status).toBe(429);
      expect(denied.headers.get("Retry-After")).toBeNull();
      expect(await readHttpFailure(denied)).toMatchObject({
        code: "STORAGE_CAPACITY",
      });
      expect(
        await owner.edit(p, {
          ...edit,
          commandId: crypto.randomUUID(),
          body: "shorter",
          expectedVersion: 2,
        }),
      ).toEqual({ kind: "storage_capacity" });
      const reserveDenied = await operator.request(
        `${server.path}/files/reserve`,
        { ...pending.command, commandId: crypto.randomUUID() },
      );
      expect(reserveDenied.status).toBe(429);
      expect(await readHttpFailure(reserveDenied)).toMatchObject({
        code: "STORAGE_CAPACITY",
      });
      expect(await counts(owner)).toEqual(paused);
      expect(await owner.attachmentStatus(p, ready.fileId)).toMatchObject({
        kind: "attachment_status",
        state: "ready",
      });
      // Accepted receipts win before the capacity admission check.
      expect(
        (
          await owner.send(p, {
            ...original,
          })
        ).outcome,
      ).toEqual({ kind: "accepted", receipt: originalReceipt });
      expect(
        await owner.edit(p, {
          ...edit,
        }),
      ).toEqual({ kind: "accepted", receipt: edited });
      expect(
        (await owner.send(p, { ...original, body: "conflict" })).outcome,
      ).toEqual({
        kind: "command_conflict",
      });
      expect(
        (await owner.send(principal("stranger"), original)).outcome,
      ).toEqual({
        kind: "forbidden",
      });
      expect(await owner.reserveAttachment(p, pending.command)).toMatchObject({
        kind: "attachment_reserved",
        fileId: pending.fileId,
      });
      expect(
        await owner.reserveAttachment(p, { ...pending.command, byteLength: 4 }),
      ).toEqual({ kind: "command_conflict" });
      expect(await owner.authorizeRegistration(registration)).toEqual(
        reservedRegistration,
      );
      expect(
        await owner.authorizeRegistration({
          ...registration,
          registrationId: crypto.randomUUID(),
          userId: "new-reservation",
        }),
      ).toEqual({ kind: "storage_capacity" });
      expect(
        await owner.redeemInvite(principal("new-member"), {
          token: invitation.token,
        }),
      ).toEqual({ kind: "storage_capacity" });
      expect(
        await owner.redeemInvite(memberPrincipal, { token: invitation.token }),
      ).toMatchObject({ kind: "joined" });
      expect(
        await owner.createInvite(
          { ...p, invitePolicy: "members" },
          { expiresAt: Date.now() + 60_000 },
        ),
      ).toEqual({ kind: "storage_capacity" });
      expect(
        await owner.createChannel(p, {
          channelId: crypto.randomUUID(),
          name: "new",
          private: false,
          expectedVersion: 3,
        }),
      ).toEqual({ kind: "storage_capacity" });
      expect(
        await owner.snapshot(p, { channelId: server.channelId }),
      ).toMatchObject({ kind: "snapshot" });
      expect(
        await owner.search(p, { channelId: server.channelId, query: "東京都" }),
      ).toMatchObject({ kind: "matches" });
      expect((await h.download(operator, live.path)).status).toBe(200);
      expect(
        AttachmentOutcomeSchema.parse(
          await (
            await h.put(operator, `${pending.path}/content`, new Uint8Array(5))
          ).json(),
        ),
      ).toMatchObject({ kind: "attachment_ready" });
      expect(await owner.cancelAttachment(p, canceled.fileId)).toEqual({
        kind: "attachment_canceled",
      });
      expect(
        await owner.updateRead(p, {
          channelId: server.channelId,
          sequence: paused.highWater,
        }),
      ).toEqual({ kind: "read_updated", sequence: paused.highWater });
      expect(
        await owner.revokeInvite(p, { token: invitation.token }),
      ).toMatchObject({ kind: "changed" });
      const deleted = accepted(
        await owner.deleteMessage(p, {
          ...messageCommand(server.channelId),
          messageId: originalReceipt.messageId,
          expectedVersion: 2,
        }),
      );
      expect(deleted.version).toBe(3);
      expect(
        await owner.setAttachmentIncident(
          { ...p, isOperator: true },
          live.fileId,
          {
            quarantined: true,
            preserve: true,
            incidentReference: "fixture-hold",
          },
        ),
      ).toEqual({ kind: "attachment_updated" });
      expect(
        await owner.setChannelMember(p, {
          channelId: privateChannel,
          userId: memberPrincipal.userId,
          allowed: false,
          expectedVersion: 1,
        }),
      ).toMatchObject({ kind: "changed" });
      headroomSamples.push((await counts(owner)).usedBytes);
      // Larger retained bodies exercise the reserve separately from the small
      // file-message tombstone. Net used pages can fall even though writes occur.
      for (const result of committed) {
        const receipt = accepted(result);
        accepted(
          await owner.deleteMessage(p, {
            ...messageCommand(server.channelId),
            messageId: receipt.messageId,
            expectedVersion: 1,
          }),
        );
        headroomSamples.push((await counts(owner)).usedBytes);
      }
      const final = OwnerCapacitySchema.parse(await owner.capacity(p));
      expect(final.attachments.heldBytes).toBe(3);
      expect(final.attachments.retiredBytes).toBeGreaterThanOrEqual(3);
      expect(final.cleanup.deletedPayloads.count).toBe(1 + committed.length);
      const retainedDeletedBodyBytes = await runInDurableObject(
        owner,
        (_instance, ctx) =>
          ctx.storage.sql
            .exec<{ bytes: number }>(
              "SELECT SUM(length(CAST(body AS BLOB))) AS bytes FROM deleted_payloads",
            )
            .one().bytes,
      );
      const afterHeadroom = await counts(owner);
      await evictDurableObject(owner);
      expect(OwnerCapacitySchema.parse(await owner.capacity(p)).sql).toEqual(
        final.sql,
      );
      expect((await owner.send(p, original)).outcome).toEqual({
        kind: "accepted",
        receipt: originalReceipt,
      });
      expect((await owner.send(p, newSend)).outcome.kind).toBe(
        final.sql.status === "paused" ? "storage_capacity" : "accepted",
      );
      Object.assign(task.meta, {
        capacityBoundary: {
          initialUsedBytes: initial.sql.usedBytes,
          warningBytes: initial.sql.warningBytes,
          pauseBytes,
          acceptedMessages: paused.messages,
          beforeRaceUsedBytes: beforeRace.usedBytes,
          competingAccepted: committed.length,
          competingRejected: rejected.length,
          afterRaceUsedBytes: paused.usedBytes,
          overshootBytes: paused.usedBytes - pauseBytes,
          afterHeadroomUsedBytes: afterHeadroom.usedBytes,
          headroomOperationNetBytes: afterHeadroom.usedBytes - paused.usedBytes,
          headroomObservedPeakAdditionalBytes:
            Math.max(...headroomSamples) - paused.usedBytes,
          headroomDeletedMessages: 1 + committed.length,
          headroomRetainedBodyBytes: retainedDeletedBodyBytes,
          afterHeadroomStatus: final.sql.status,
          remainingBudgetBytes:
            initial.sql.budgetBytes - afterHeadroom.usedBytes,
        },
      });
    },
    60_000,
  );

  it("authorizes aggregate inspection without exposing private content and validates budget configuration", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator, "private server name");
    const member = await h.registerMember(operator, server.owner.id);
    const owner = env.SERVER_DO.getByName(server.owner.id);
    const p = principal(operator.profile!.userId);
    accepted(
      (
        await owner.send(
          p,
          messageCommand(server.channelId, "private body absent from report"),
        )
      ).outcome,
    );
    expect(
      (await member.member.request(`${server.path}/capacity`)).status,
    ).toBe(403);
    const response = await operator.request(`${server.path}/capacity`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const parsed = OwnerCapacitySchema.parse(await response.json());
    expect(parsed.sockets).toEqual({ tickets: 0, active: 0 });
    expect(JSON.stringify(parsed)).not.toMatch(
      /private body|private server name|channelId|userId/,
    );
    const ticket = await owner.prepareSocket(p, {
      channelId: server.channelId,
    });
    if (ticket.kind !== "socket_ticket")
      throw new Error("Missing socket ticket");
    expect(OwnerCapacitySchema.parse(await owner.capacity(p)).sockets).toEqual({
      tickets: 1,
      active: 0,
    });
    const socket = await applicationSocket(
      await owner.fetch(
        new Request("https://vaskel.test/events", {
          headers: {
            Upgrade: "websocket",
            "X-Vaskel-User-Id": p.userId,
            "X-Vaskel-Session-Id": p.sessionId,
            "X-Vaskel-Assertion-Expires-At": String(p.expiresAt),
            "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${ticket.ticket}`,
          },
        }),
      ),
    );
    expect(OwnerCapacitySchema.parse(await owner.capacity(p)).sockets).toEqual({
      tickets: 0,
      active: 1,
    });
    await socket.close();
    const conversation = ResourceCreatedSchema.parse(
      await (
        await operator.request("/api/conversations", {
          userId: member.member.profile!.userId,
        })
      ).json(),
    );
    if (conversation.kind !== "created")
      throw new Error("Missing conversation");
    const dm = env.CONVERSATION_DO.getByName(conversation.owner.id);
    const dmPath = `${resourcePath(conversation.owner)}/capacity`;
    expect(await dm.capacity(p)).toEqual({ kind: "forbidden" });
    expect(
      OwnerCapacitySchema.parse(await dm.capacity({ ...p, isOperator: true }))
        .sql.status,
    ).toBe("normal");
    expect(await dm.capacity({ ...p, isOperator: true, expiresAt: 0 })).toEqual(
      { kind: "unauthenticated" },
    );
    expect(
      await owner.capacity({
        ...principal("unrelated-operator"),
        isOperator: true,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      (
        await member.member.request(dmPath, undefined, {
          headers: { "X-Vaskel-Operator": "true" },
        })
      ).status,
    ).toBe(403);
    expect(
      OwnerCapacitySchema.parse(await (await operator.request(dmPath)).json())
        .kind,
    ).toBe("owner_capacity");
    await env.IDENTITY_DB.prepare("DELETE FROM identity_operator").run();
    expect((await operator.request(dmPath)).status).toBe(403);
    expect((await operator.request(`${server.path}/capacity`)).status).toBe(
      200,
    );
    // Invalid operator configuration fails closed before an owner can admit data.
    for (const value of [
      "",
      "8388607",
      "8589934593",
      "1e9",
      "8388608.0",
      " 8388608",
      "-8388608",
      "9007199254740992",
    ])
      expect(() => ownerSqlBudgetBytes(value)).toThrow(
        /OWNER_SQL_BUDGET_BYTES/,
      );
    expect(
      OwnerCapacityOutcomeSchema.parse(
        await owner.capacity({ ...p, expiresAt: 0 }),
      ),
    ).toEqual({ kind: "unauthenticated" });
  });

  it.skipIf(env.OWNER_SQL_BUDGET_BYTES !== String(64 * 1_024 ** 2))(
    "measures bounded mixed-script workloads and delayed replay at 64 MiB",
    async ({ task }) => {
      const measurements = [];
      for (const concurrency of [1, 8]) {
        const id = crypto.randomUUID();
        const owner = env.SERVER_DO.getByName(id);
        const p = principal();
        expect(
          await owner.initialize({
            serverId: id,
            name: "measurement",
            ownerId: p.userId,
          }),
        ).toMatchObject({ kind: "initialized" });
        const initial = await owner.snapshot(p, { channelId: id });
        if (initial.kind !== "snapshot")
          throw new Error("Missing initial cursor");
        let populated = 0;
        let cumulativeEdited = 0;
        let cumulativeDeleted = 0;
        let totalBodyBytes = 0;
        for (const target of [100, 400, 1_200]) {
          const latency = {
            send: [] as number[],
            edit: [] as number[],
            delete: [] as number[],
            snapshot: [] as number[],
            search: [] as number[],
          };
          const stageStart = performance.now();
          const receipts: { receipt: Receipt; index: number; body: string }[] =
            [];
          for (let start = populated; start < target; start += concurrency) {
            await Promise.all(
              Array.from(
                { length: Math.min(concurrency, target - start) },
                async (_, offset) => {
                  const index = start + offset;
                  const body = mixedBody(index);
                  totalBodyBytes += new TextEncoder().encode(body).byteLength;
                  const result = await timed(latency.send, () =>
                    owner
                      .send(p, messageCommand(id, body))
                      .then(({ outcome }) => outcome),
                  );
                  receipts.push({ receipt: accepted(result), index, body });
                },
              ),
            );
          }
          // Exactly 10% edited, 5% deleted; disjoint sets, durable receipts retained.
          for (const { receipt, index, body } of receipts) {
            if (index % 10 === 0) {
              accepted(
                await timed(latency.edit, () =>
                  owner.edit(p, {
                    ...messageCommand(id, body.replace("item", "edit")),
                    messageId: receipt.messageId,
                    expectedVersion: 1,
                  }),
                ),
              );
              cumulativeEdited++;
            } else if (index % 20 === 1) {
              accepted(
                await timed(latency.delete, () =>
                  owner.deleteMessage(p, {
                    ...messageCommand(id),
                    messageId: receipt.messageId,
                    expectedVersion: 1,
                  }),
                ),
              );
              cumulativeDeleted++;
            }
          }
          const workloadMs = performance.now() - stageStart;
          for (let sample = 0; sample < 24; sample++) {
            expect(
              (
                await timed(latency.snapshot, () =>
                  owner.snapshot(p, { channelId: id }),
                )
              ).kind,
            ).toBe("snapshot");
            expect(
              (
                await timed(latency.search, () =>
                  owner.search(p, { channelId: id, query: "東京都" }),
                )
              ).kind,
            ).toBe("matches");
          }
          const native = await nativeMeasurements(owner, id);
          const report = OwnerCapacitySchema.parse(await owner.capacity(p));
          expect(report.sql.budgetBytes).toBe(64 * 1_024 ** 2);
          expect(report.sql.status).toBe("normal");
          expect(native.counts.messages).toBe(target);
          expect(native.counts.tombstones).toBe(cumulativeDeleted);
          expect(native.counts.receipts).toBe(
            target + cumulativeEdited + cumulativeDeleted,
          );
          const head = await owner.snapshot(p, { channelId: id, limit: 1 });
          if (head.kind !== "snapshot") throw new Error("Missing snapshot");
          const deferred = await owner.replay(p, {
            channelId: id,
            cursor: initial.cursor,
          });
          if (target === 1_200)
            expect(deferred).toEqual({
              kind: "reset_required",
              reason: "floor",
            });
          else expect(deferred.kind).toBe("replay");
          // Application consumer deliberately waits between bounded pages. This
          // measures replay recovery, not transport buffering or socket delivery.
          let replayCursor = {
            ...head.cursor,
            sequence: Math.max(0, head.cursor.sequence - 200),
          };
          const replayLatency: number[] = [];
          let events = 0;
          const recoveryStart = performance.now();
          for (let page = 0; page < 3; page++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const replay = await timed(replayLatency, () =>
              owner.replay(p, {
                channelId: id,
                cursor: replayCursor,
                limit: 100,
              }),
            );
            if (replay.kind !== "replay")
              throw new Error(`Unexpected replay: ${replay.kind}`);
            events += replay.events.length;
            replayCursor = replay.cursor;
            if (!replay.hasMore) break;
          }
          expect(replayCursor.sequence).toBe(head.cursor.sequence);
          measurements.push({
            concurrency,
            cumulativeMessages: target,
            newlySent: target - populated,
            cumulativeEdited,
            cumulativeDeleted,
            cumulativeOriginalPayloadBytes: totalBodyBytes,
            workloadMs,
            sql: report.sql,
            retainedPayload: native.payload,
            counts: native.counts,
            latencyMs: Object.fromEntries(
              Object.entries(latency).map(([operation, samples]) => [
                operation,
                distribution(samples),
              ]),
            ),
            nativeStatementRowsRead: native.rowsRead,
            delayedReplay: {
              consumerDelayPerPageMs: 25,
              events,
              cursorReachedHead: true,
              rpcLatencyMs: distribution(replayLatency),
              recoveryMs: performance.now() - recoveryStart,
              originalCursorOutcome: deferred.kind,
            },
          });
          populated = target;
        }
      }
      Object.assign(task.meta, {
        capacityMeasurement: {
          settings: {
            budgetBytes: 64 * 1_024 ** 2,
            cumulativeSizes: [100, 400, 1_200],
            concurrency: [1, 8],
            editedFraction: 0.1,
            deletedFraction: 0.05,
            messageEncoding: "UTF-8 mixed CJK/Latin/emoji near 1 KiB",
            searchQuery: "東京都",
            readSamplesPerStage: 24,
            rpcTransport: "official Cloudflare test harness RPC",
            nativeRowsReadScope:
              "Standalone snapshot/search SQL statements; excludes owner authorization, materialization and full RPC costs",
            delayedReplayScope:
              "25 ms application pauses between RPC pages; no WebSocket backpressure or recipient-delivery measurement",
            latencyLimit: "No production SLO or throughput threshold",
          },
          measurements,
        },
      });
    },
    120_000,
  );
});

function mixedBody(index: number) {
  const prefix = `item-${String(index).padStart(4, "0")} 東京都 `;
  const phrase = "数据库設計 한국어 日本語 Latin text 🌿🪷🧵. ";
  let body = prefix;
  while (new TextEncoder().encode(body + phrase).byteLength <= 1_024)
    body += phrase;
  return MessageBodySchema.parse(body);
}
async function timed<T>(samples: number[], action: () => T) {
  const start = performance.now();
  const result = await action();
  samples.push(performance.now() - start);
  return result;
}
function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    count: samples.length,
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0,
  };
}
async function nativeMeasurements(owner: Owner, channelId: string) {
  return runInDurableObject(owner, async (_instance, ctx) => {
    const sql = ctx.storage.sql;
    const counts = sql
      .exec<{
        messages: number;
        tombstones: number;
        receipts: number;
        events: number;
        fts: number;
      }>(
        `SELECT
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM messages WHERE deleted_at IS NOT NULL) AS tombstones,
      (SELECT COUNT(*) FROM command_receipts) AS receipts,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM message_fts) AS fts`,
      )
      .one();
    const payload = sql
      .exec<{ liveBodyBytes: number; deletedBodyBytes: number }>(
        `SELECT
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM messages) AS liveBodyBytes,
      (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM deleted_payloads) AS deletedBodyBytes`,
      )
      .one();
    const snapshot = sql.exec(
      "SELECT * FROM messages WHERE channel_id = ? ORDER BY created_sequence DESC LIMIT 41",
      channelId,
    );
    snapshot.toArray();
    const database = openOwnerDatabase(ctx.storage);
    const observed = await observeSql(sql, () =>
      searchMessages(ctx.storage, database, principal(), {
        channelId,
        query: "東京都",
      }),
    );
    expect(observed.value.kind).toBe("matches");
    const search = observed.statements.find(({ query }) =>
      query.includes("message_fts"),
    )!;
    return {
      counts,
      payload,
      rowsRead: { snapshot: snapshot.rowsRead, search: search.rowsRead },
    };
  });
}

it("bounds complete snapshot, replay and notification query work", async () => {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({
    serverId: id,
    name: "Query work",
    ownerId: principal().userId,
  });
  await runInDurableObject(owner, async (instance, state) => {
    const database = openOwnerDatabase(state.storage);
    const initial = await instance.snapshot(principal(), { channelId: id });
    if (initial.kind !== "snapshot") throw new Error(initial.kind);
    state.storage.sql.exec(
      "INSERT INTO members(user_id,role) VALUES ('capacity-reader','member')",
    );
    for (let index = 0; index < 101; index++) {
      const result = await mutateMessage(
        state.storage,
        database,
        principal(),
        {
          kind: "send",
          command: messageCommand(
            id,
            `${mixedBody(index)} [](/mentions/capacity-reader)`,
          ),
        },
        Number.MAX_SAFE_INTEGER,
      );
      if (result.kind !== "committed") throw new Error(result.kind);
      state.storage.sql.exec(
        "INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES (?,'capacity-reader','👍',?)",
        result.receipt.messageId,
        Date.now(),
      );
    }
    const references = state.storage.sql
      .exec<{ id: string; created_sequence: number; created_at: number }>(
        "SELECT id,created_sequence,created_at FROM messages ORDER BY created_sequence DESC LIMIT 32",
      )
      .toArray()
      .map((row) => ({
        owner: initial.cursor.owner,
        ownerGeneration: initial.cursor.generation,
        roomId: id,
        messageId: row.id,
        sequence: row.created_sequence,
        createdAt: row.created_at,
        senderLabel: "Capacity owner",
      }));
    const workloads = {
      snapshot1: async () => {
        const result = await instance.snapshot(principal("capacity-reader"), {
          channelId: id,
          limit: 1,
        });
        if (result.kind !== "snapshot") throw new Error(result.kind);
        expect(result.messages).toHaveLength(1);
        expect(result.nextBefore).toBe(101);
      },
      snapshot40: async () => {
        const result = await instance.snapshot(principal("capacity-reader"), {
          channelId: id,
        });
        if (result.kind !== "snapshot") throw new Error(result.kind);
        expect(result.messages).toHaveLength(40);
        expect(result.messages[0]!.createdSequence).toBe(62);
        expect(result.messages[39]!.reactions).toEqual([
          { emoji: "👍", count: 1, mine: true },
        ]);
        expect(result.nextBefore).toBe(62);
      },
      replay100: async () => {
        const result = await instance.replay(principal("capacity-reader"), {
          channelId: id,
          cursor: initial.cursor,
        });
        if (result.kind !== "replay") throw new Error(result.kind);
        expect(result.events).toHaveLength(100);
        expect(result.cursor.sequence).toBe(100);
        expect(result.highWater).toBe(101);
        expect(result.hasMore).toBe(true);
      },
      notification32: async () => {
        const result = await instance.selectNotificationMessage(
          "capacity-reader",
          references,
          { directOnly: true, includeText: true },
        );
        expect(result?.reference).toEqual(
          references.toSorted((a, b) => b.createdAt - a.createdAt)[0],
        );
        expect(result?.trigger).toBe("direct");
      },
    };
    const selectLimits: Record<string, number> = {
      snapshot1: 6,
      snapshot40: 6,
      replay100: 6,
      notification32: 5,
    };
    for (const [workload, action] of Object.entries(workloads)) {
      const { statements } = await observeSql(state.storage.sql, action);
      expect(selectStatements(statements).length).toBeLessThanOrEqual(
        selectLimits[workload]!,
      );
      expect(statements.every(({ bindings }) => bindings.length <= 100)).toBe(
        true,
      );
      expect(statements.every(({ rowsWritten }) => rowsWritten === 0)).toBe(
        true,
      );
    }
  });
});
