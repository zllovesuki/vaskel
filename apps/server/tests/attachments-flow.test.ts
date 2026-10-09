import { readHttpFailure } from "@tests/helpers/http";
import { decode } from "hono/jwt";
import { fileGrantPath } from "@vaskel/contracts/api";
import { ATTACHMENT_GRANT_MS, mintAttachmentGrant } from "@/server/files/grant";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { ResourceCreatedSchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import {
  attachmentHarness,
  attachmentResult,
  messagingResult,
} from "@tests/helpers/attachment-harness";
import {
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
} from "@tests/helpers/application-harness";

const network = setupNetwork();
let externalRequests = 0;
network.configure({ onUnhandledFrame: "error" });
beforeAll(() => network.enable());
beforeEach(() => {
  externalRequests = 0;
  network.use(
    http.all("*", () => {
      externalRequests++;
      return HttpResponse.json(
        { error: "unexpected_external_request" },
        { status: 503 },
      );
    }),
  );
});
afterEach(() => {
  network.resetHandlers();
  expect(
    externalRequests,
    "Attachment HTTP flows must not dispatch external requests",
  ).toBe(0);
});
afterAll(() => network.disable());

describe("private attachments through authenticated HTTP and native R2", () => {
  it("recovers one ordered attachment-only DM send and hides deleted files in HTTP, replay and socket producers before byte GC", async () => {
    const h = attachmentHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member, registered } = await h.registerMember(
      operator,
      server.owner.id,
    );
    const dm = await decodeApplicationResponse(
      await operator.request("/api/conversations", {
        userId: registered.userId,
      }),
      ResourceCreatedSchema,
    );
    if (dm.kind !== "created")
      throw new Error(`DM creation failed: ${dm.kind}`);
    const path = resourcePath(dm.owner);
    const before = await messagingResult(
      await member.request(`${path}/snapshot`, { channelId: dm.channelId }),
    );
    if (before.kind !== "snapshot")
      throw new Error(`Snapshot failed: ${before.kind}`);
    // Exceeds the ordinary JSON ingress cap; the real binary route must stream it.
    const first = await h.upload(
      operator,
      path,
      dm.channelId,
      "東京の資料.txt",
      new Uint8Array(300_000).fill(73),
    );
    const second = await h.upload(
      operator,
      path,
      dm.channelId,
      "添付二.bin",
      new Uint8Array([0, 255, 128, 10]),
    );
    expect(
      await attachmentResult(
        await operator.request(`${path}/files/reserve`, first.command),
      ),
    ).toMatchObject({ kind: "attachment_reserved", fileId: first.fileId });
    expect(
      await attachmentResult(await operator.request(`${first.path}/status`)),
    ).toMatchObject({
      kind: "attachment_status",
      state: "ready",
      attachment: first.attachment,
    });
    expect(
      await readHttpFailure(await member.request(`${first.path}/status`)),
    ).toMatchObject({ code: "NOT_FOUND" });
    for (const client of [operator, member]) {
      expect(
        await readHttpFailure(await client.request(`${first.path}/grant`)),
      ).toMatchObject({ code: "NOT_FOUND" });
    }

    const stream = await h.socket(member, path, dm.channelId);
    try {
      const command = {
        ...messageCommand(dm.channelId, ""),
        attachmentIds: [second.fileId, first.fileId],
      };
      const sent = await messagingResult(
        await operator.request(`${path}/send`, command),
      );
      if (sent.kind !== "accepted")
        throw new Error(`Send failed: ${sent.kind}`);
      const frame = await stream.next();
      expect(frame).toMatchObject({
        type: "committed",
        event: {
          operation: "send",
          message: {
            id: sent.receipt.messageId,
            body: "",
            attachments: [second.attachment, first.attachment],
          },
        },
      });
      expect(
        await messagingResult(await operator.request(`${path}/send`, command)),
      ).toEqual(sent);
      // Receipt recovery may rebroadcast the same durable sequence.
      expect(await stream.next()).toEqual(frame);
      expect(
        await readHttpFailure(
          await operator.request(`${path}/send`, {
            ...command,
            attachmentIds: [...command.attachmentIds].reverse(),
          }),
        ),
      ).toMatchObject({ code: "COMMAND_CONFLICT" });
      expect(
        await readHttpFailure(
          await operator.request(`${first.path}/cancel`, undefined, {
            method: "POST",
          }),
        ),
      ).toMatchObject({ code: "ATTACHMENT_CLAIMED" });
      const snapshot = await messagingResult(
        await member.request(`${path}/snapshot`, { channelId: dm.channelId }),
      );
      if (snapshot.kind !== "snapshot")
        throw new Error(`Snapshot failed: ${snapshot.kind}`);
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.cursor.sequence).toBe(sent.receipt.sequence);
      expect(snapshot.messages[0]?.attachments).toEqual([
        second.attachment,
        first.attachment,
      ]);
      const granted = await h.grant(member, first.path);
      expect(granted.expiresAt).toBeGreaterThan(Date.now());
      const download = await member.request(granted.url);
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Type")).toBe(
        "application/octet-stream",
      );
      expect(download.headers.get("Content-Disposition")).toMatch(
        /^attachment;/,
      );
      expect(download.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(download.headers.get("Accept-Ranges")).toBe("bytes");
      expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(download.headers.get("Content-Disposition")).toContain(
        `filename*=UTF-8''${encodeURIComponent(first.attachment.filename)}`,
      );
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(first.bytes);
      // The token alone admits the read: no cookie and no origin are sent.
      const anonymous = await h.app.request(
        `${h.environment.AUTH_ORIGIN}${granted.url}`,
        undefined,
        h.environment,
      );
      expect(anonymous.status).toBe(200);
      expect(new Uint8Array(await anonymous.arrayBuffer())).toEqual(
        first.bytes,
      );
      const ranged = await member.request(granted.url, undefined, {
        headers: { Range: "bytes=0-0" },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("Content-Range")).toBe(
        `bytes 0-0/${first.bytes.byteLength}`,
      );
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
        first.bytes.slice(0, 1),
      );
      const revalidated = await member.request(granted.url, undefined, {
        headers: { "If-None-Match": download.headers.get("ETag") ?? "" },
      });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe("");
      const head = await member.request(granted.url, undefined, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe(
        String(first.bytes.byteLength),
      );
      expect(await head.text()).toBe("");
      const token = granted.url.slice(fileGrantPath("").length);
      const tail = token.slice(-4) === "AAAA" ? "BBBB" : "AAAA";
      expect(
        await readHttpFailure(
          await member.request(fileGrantPath(`${token.slice(0, -4)}${tail}`)),
        ),
      ).toMatchObject({ code: "UNAUTHENTICATED" });
      const claims = decode(token).payload as {
        fileId: string;
        key: string;
        etag: string;
        version: string;
        byteLength: number;
        filename: string;
      };
      const expired = await mintAttachmentGrant(
        h.environment,
        {
          fileId: claims.fileId,
          objectKey: claims.key,
          etag: claims.etag,
          version: claims.version,
          byteLength: claims.byteLength,
          filename: claims.filename,
          generation: "",
          messageId: "",
        },
        Date.now() - ATTACHMENT_GRANT_MS - 1_000,
      );
      expect(
        await readHttpFailure(
          await member.request(fileGrantPath(expired.token)),
        ),
      ).toMatchObject({ code: "UNAUTHENTICATED" });
      expect(
        await readHttpFailure(
          await operator.request(`${server.path}/files/${first.fileId}/grant`),
        ),
      ).toMatchObject({ code: "NOT_FOUND" });

      const removed = await messagingResult(
        await operator.request(`${path}/delete`, {
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
          channelId: dm.channelId,
          messageId: sent.receipt.messageId,
          expectedVersion: sent.receipt.version,
        }),
      );
      if (removed.kind !== "accepted")
        throw new Error(`Delete failed: ${removed.kind}`);
      expect(await stream.next()).toMatchObject({
        type: "committed",
        event: {
          operation: "delete",
          message: { id: sent.receipt.messageId, body: null, attachments: [] },
        },
      });
      const deleted = await messagingResult(
        await member.request(`${path}/snapshot`, { channelId: dm.channelId }),
      );
      expect(deleted).toMatchObject({
        kind: "snapshot",
        messages: [{ id: sent.receipt.messageId, body: null, attachments: [] }],
      });
      const replay = await messagingResult(
        await member.request(`${path}/replay`, {
          channelId: dm.channelId,
          cursor: before.cursor,
        }),
      );
      if (replay.kind !== "replay")
        throw new Error(`Replay failed: ${replay.kind}`);
      expect(
        replay.events.map((event) => [
          event.message.id,
          event.message.body,
          event.message.attachments,
        ]),
      ).toEqual([
        [sent.receipt.messageId, null, []],
        [sent.receipt.messageId, null, []],
      ]);
      expect(
        await attachmentResult(await operator.request(`${first.path}/status`)),
      ).toEqual({ kind: "attachment_status", state: "unavailable" });
      expect(
        await readHttpFailure(await member.request(`${first.path}/grant`)),
      ).toMatchObject({ code: "NOT_FOUND" });
      // An issued URL is bearer access until it expires or the object is deleted.
      expect((await member.request(granted.url)).status).toBe(200);
      expect((await h.environment.ATTACHMENTS.list()).objects).toHaveLength(2);
      const owner = h.environment.CONVERSATION_DO.getByName(dm.owner.id);
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE attachments SET cleanup_at = 0 WHERE state = 'retired'",
        );
      });
      await runDurableObjectAlarm(owner);
      expect((await h.environment.ATTACHMENTS.list()).objects).toEqual([]);
      expect(
        await readHttpFailure(await member.request(granted.url)),
      ).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await stream.close();
    }
  });

  it("uses current private-channel access for both uploader and administrator while permitting contentless discard after revocation", async () => {
    const h = attachmentHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member, registered } = await h.registerMember(
      operator,
      server.owner.id,
    );
    const directory = await decodeApplicationResponse(
      await operator.request(server.path),
      DirectoryOutcomeSchema,
    );
    if (directory.kind !== "directory")
      throw new Error(`Directory failed: ${directory.kind}`);
    const channelId = crypto.randomUUID();
    expect(
      await decodeApplicationResponse(
        await operator.request(`/api/servers/${server.owner.id}/channels`, {
          channelId,
          name: "Private files",
          kind: "text",
          private: true,
          expectedVersion: directory.version,
        }),
        AdministrationOutcomeSchema,
      ),
    ).toMatchObject({ kind: "changed" });
    async function membership(
      userId: string,
      allowed: boolean,
      expectedVersion: number,
    ) {
      const result = await decodeApplicationResponse(
        await operator.request(
          `/api/servers/${server.owner.id}/channel-member`,
          { channelId, userId, allowed, expectedVersion },
        ),
        AdministrationOutcomeSchema,
      );
      if (result.kind !== "changed")
        throw new Error(`Channel membership failed: ${result.kind}`);
      return result.version;
    }
    let version = await membership(registered.userId, true, 1);
    const file = await h.upload(
      member,
      server.path,
      channelId,
      "私人文件.txt",
      new TextEncoder().encode("Private original"),
    );
    const discarded = await h.upload(
      member,
      server.path,
      channelId,
      "不要公开.txt",
      new TextEncoder().encode("Never published"),
    );
    for (const [client, targetChannel] of [
      [operator, channelId],
      [member, server.channelId],
    ] as const) {
      expect(
        await readHttpFailure(
          await client.request(`${server.path}/send`, {
            ...messageCommand(targetChannel, ""),
            attachmentIds: [file.fileId],
          }),
        ),
      ).toMatchObject({ code: "ATTACHMENT_NOT_READY" });
    }
    const sent = await messagingResult(
      await member.request(`${server.path}/send`, {
        ...messageCommand(channelId, ""),
        attachmentIds: [file.fileId],
      }),
    );
    if (sent.kind !== "accepted") throw new Error(`Send failed: ${sent.kind}`);
    const allowed = await h.download(operator, file.path);
    expect(allowed.status).toBe(200);
    expect(new TextDecoder().decode(await allowed.arrayBuffer())).toBe(
      "Private original",
    );
    if (!operator.profile) throw new Error("Missing fixture operator profile");
    version = await membership(operator.profile.userId, false, version);
    expect(
      await readHttpFailure(await operator.request(`${file.path}/grant`)),
    ).toMatchObject({ code: "FORBIDDEN" });
    version = await membership(registered.userId, false, version);
    expect(
      await readHttpFailure(await member.request(`${file.path}/grant`)),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await readHttpFailure(await member.request(`${discarded.path}/status`)),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await attachmentResult(
        await member.request(`${discarded.path}/cancel`, undefined, {
          method: "POST",
        }),
      ),
    ).toEqual({ kind: "attachment_canceled" });
    expect(
      await attachmentResult(
        await member.request(`${discarded.path}/cancel`, undefined, {
          method: "POST",
        }),
      ),
    ).toEqual({ kind: "attachment_canceled" });
    await membership(registered.userId, true, version);
    expect(
      await attachmentResult(await member.request(`${discarded.path}/status`)),
    ).toEqual({ kind: "attachment_status", state: "unavailable" });
    const restored = await h.download(member, file.path);
    expect(restored.status).toBe(200);
    expect(new TextDecoder().decode(await restored.arrayBuffer())).toBe(
      "Private original",
    );
    const issued = await h.grant(member, file.path);
    expect(
      await attachmentResult(
        await operator.request(`${file.path}/incident`, {
          quarantined: true,
          preserve: false,
          incidentReference: "review-1",
        }),
      ),
    ).toEqual({ kind: "attachment_updated" });
    expect(
      await readHttpFailure(await member.request(`${file.path}/grant`)),
    ).toMatchObject({ code: "NOT_FOUND" });
    // Quarantine refuses new grants; an issued URL stays usable until it expires.
    expect((await member.request(issued.url)).status).toBe(200);
  });
});
