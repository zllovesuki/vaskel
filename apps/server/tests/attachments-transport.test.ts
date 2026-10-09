import { readHttpFailure } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uploadAttachment } from "@/server/files/upload";
import { serveAttachment } from "@/server/files/download";
import type { GrantClaims } from "@/server/files/grant";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal } from "@/server/directory/owners";
import type { Principal } from "@/server/domain/principal";
import { applicationHarness } from "@tests/helpers/application-harness";

const principal = (): Principal => ({
  userId: "alice",
  sessionId: "session-alice",
  expiresAt: Date.now() + 60_000,
});
async function setup() {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({ serverId: id, name: "Transport", ownerId: "alice" });
  const reserve = async (byteLength = 3) => {
    const result = await owner.reserveAttachment(principal(), {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      channelId: id,
      filename: "日本語.txt",
      byteLength,
    });
    if (result.kind !== "attachment_reserved") throw new Error(result.kind);
    return result;
  };
  return { id, owner, reserve };
}
function request(body: BodyInit, headers?: HeadersInit) {
  return new Request("https://vaskel.test/upload", {
    method: "PUT",
    body,
    ...(headers ? { headers } : {}),
  });
}

describe("streamed attachment transport admission", () => {
  it("rejects short, long and disconnected streams and never retries an uncertain key", async () => {
    const h = await setup();
    for (const shape of ["short", "long", "disconnected"] as const) {
      const file = await h.reserve();
      const pending: Promise<unknown>[] = [];
      let step = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (step++ === 0)
            controller.enqueue(new Uint8Array(shape === "long" ? 4 : 2));
          else if (shape === "disconnected")
            controller.error(new Error("fixture disconnected"));
          else controller.close();
        },
      });
      const outcome = await uploadAttachment(
        request(body),
        env.ATTACHMENTS,
        h.owner,
        principal(),
        file.fileId,
        async () => principal(),
        (work) => pending.push(work),
      );
      await Promise.all(pending);
      expect(["integrity_mismatch", "attachment_not_ready"]).toContain(
        outcome.kind,
      );
      expect(await h.owner.attachmentStatus(principal(), file.fileId)).toEqual({
        kind: "attachment_status",
        state: "unavailable",
      });
      expect(
        await uploadAttachment(
          request(new Uint8Array(3)),
          env.ATTACHMENTS,
          h.owner,
          principal(),
          file.fileId,
          async () => principal(),
          (work) => pending.push(work),
        ),
      ).toEqual({ kind: "attachment_expired" });
      await runInDurableObject(h.owner, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              "SELECT state, outstanding FROM attachments WHERE id = ?",
              file.fileId,
            )
            .one(),
        ).toEqual({ state: "retired", outstanding: 1 });
      });
    }
    const neverStarted = await h.reserve();
    expect(
      await uploadAttachment(
        request(new Uint8Array(3), { "Content-Length": "4" }),
        env.ATTACHMENTS,
        h.owner,
        principal(),
        neverStarted.fileId,
        async () => principal(),
        () => undefined,
      ),
    ).toEqual({ kind: "integrity_mismatch" });
    await runDurableObjectAlarm(h.owner);
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT state, writer_state FROM attachments WHERE id = ?",
            neverStarted.fileId,
          )
          .one(),
      ).toEqual({ state: "cleaned", writer_state: "never_started" });
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 9 });
    });
  });

  it("rechecks channel access after a delayed PUT", async () => {
    const h = await setup();
    const file = await h.reserve();
    const entered = deferred();
    const release = deferred();
    const pending: Promise<unknown>[] = [];
    const upload = uploadAttachment(
      request(new Uint8Array(3)),
      {
        put: async (key, body, options) => {
          const object = await env.ATTACHMENTS.put(key, body, options);
          entered.resolve();
          await release.promise;
          return object;
        },
      },
      h.owner,
      principal(),
      file.fileId,
      async () => principal(),
      (work) => pending.push(work),
    );
    await entered.promise;
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE channels SET private = 1 WHERE id = ?",
        h.id,
      );
    });
    release.resolve();
    expect(await upload).toEqual({ kind: "forbidden" });
    await Promise.all(pending);
    await runInDurableObject(h.owner, (_instance, state) => {
      const attachment = state.storage.sql
        .exec(
          "SELECT state, writer_state FROM attachments WHERE id = ?",
          file.fileId,
        )
        .one();
      // A settled writer may already have been cleaned by the owner alarm.
      expect(["retired", "cleaned"]).toContain(attachment.state);
      expect(attachment.writer_state).toBe("settled");
      state.storage.sql.exec(
        "UPDATE channels SET private = 0 WHERE id = ?",
        h.id,
      );
    });
  });

  it("settles a stored upload before propagating identity infrastructure failures", async () => {
    const h = await setup();
    const failed = await h.reserve();
    const unavailable = async () => {
      throw new Error("identity unavailable");
    };
    await expect(
      uploadAttachment(
        request(new Uint8Array(3)),
        env.ATTACHMENTS,
        h.owner,
        principal(),
        failed.fileId,
        unavailable,
        () => {},
      ),
    ).rejects.toThrow("identity unavailable");
    await runInDurableObject(h.owner, (_, state) => {
      const attachment = state.storage.sql
        .exec(
          "SELECT state,writer_state FROM attachments WHERE id=?",
          failed.fileId,
        )
        .one();
      expect(["retired", "cleaned"]).toContain(attachment.state);
      expect(attachment.writer_state).toBe("settled");
    });
  });

  it("refreshes the actual D1 session after PUT and denies an object whose session was revoked while writing", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const owner = env.SERVER_DO.getByName(server.owner.id);
    const req = request(new Uint8Array(3), {
      Origin: env.AUTH_ORIGIN,
      Cookie: operator.cookie,
    });
    const identity = await getPrincipal(req, h.environment);
    if (!identity) throw new Error("Missing fixture session");
    const reservation = await owner.reserveAttachment(
      actorPrincipal(identity),
      {
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
        channelId: server.channelId,
        filename: "private.txt",
        byteLength: 3,
      },
    );
    if (reservation.kind !== "attachment_reserved")
      throw new Error(reservation.kind);
    let refreshes = 0;
    const pending: Promise<unknown>[] = [];
    const result = await uploadAttachment(
      req,
      {
        put: async (key, body, options) => {
          const object = await env.ATTACHMENTS.put(key, body, options);
          await env.IDENTITY_DB.prepare(
            "DELETE FROM identity_session WHERE id = ?",
          )
            .bind(identity.sessionId)
            .run();
          return object;
        },
      },
      owner,
      actorPrincipal(identity),
      reservation.fileId,
      async () => {
        refreshes++;
        const fresh = await getPrincipal(req, h.environment);
        return fresh ? actorPrincipal(fresh) : null;
      },
      (work) => pending.push(work),
    );
    await Promise.all(pending);
    expect(refreshes).toBe(1);
    expect(result).toEqual({ kind: "unauthenticated" });
    await runInDurableObject(owner, (_instance, state) => {
      const file = state.storage.sql
        .exec<{ state: string; writer_state: string; outstanding: number }>(
          "SELECT state, writer_state, outstanding FROM attachments WHERE id = ?",
          reservation.fileId,
        )
        .one();
      // Native alarms may already have cleaned this unclaimed, settled writer.
      expect(["retired", "cleaned"]).toContain(file.state);
      expect(file.writer_state).toBe("settled");
    });
    expect(
      await owner.authorizeAttachmentDownload(
        actorPrincipal(identity),
        reservation.fileId,
      ),
    ).toEqual({ kind: "not_found" });
    await runDurableObjectAlarm(owner);
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT state,outstanding FROM attachments WHERE id=?",
            reservation.fileId,
          )
          .one(),
      ).toEqual({ state: "cleaned", outstanding: 0 });
    });
  });
});

const ascii = (value: string) => Array.from(value, (c) => c.charCodeAt(0));
const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1,
]);
const ebml = [
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
  0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08,
];
const webm = new Uint8Array([
  ...ebml,
  0x42,
  0x82,
  0x84,
  ...ascii("webm"),
  0x42,
  0x87,
  0x81,
  0x02,
]);
const matroska = new Uint8Array([
  ...ebml,
  0x42,
  0x82,
  0x88,
  ...ascii("matroska"),
  0x42,
  0x87,
  0x81,
  0x04,
]);
const mp4 = new Uint8Array([
  0,
  0,
  0,
  24,
  ...ascii("ftypisom"),
  0,
  0,
  0,
  1,
  ...ascii("isomavc1"),
]);
const quicktime = new Uint8Array([
  0,
  0,
  0,
  20,
  ...ascii("ftypqt  "),
  0,
  0,
  0,
  0,
  ...ascii("qt  "),
]);
const text = new TextEncoder().encode("plain text");

describe("granted byte serving", () => {
  async function granted(bytes: Uint8Array): Promise<GrantClaims> {
    const fileId = crypto.randomUUID();
    const key = `transport-test/${fileId}`;
    const object = await env.ATTACHMENTS.put(key, bytes);
    if (!object) throw new Error("Fixture PUT failed");
    const issuedAt = Math.floor(Date.now() / 1_000);
    return {
      aud: "vaskel:attachment",
      iat: issuedAt,
      exp: issuedAt + 3_600,
      fileId,
      key,
      etag: object.etag,
      version: object.version,
      byteLength: bytes.byteLength,
      filename: "日本語.txt",
    };
  }
  const serve = (claims: GrantClaims, init?: RequestInit) =>
    serveAttachment(
      new Request("https://vaskel.test/files/granted", init),
      env.ATTACHMENTS,
      claims,
    );
  const body = async (response: Response) =>
    new Uint8Array(await response.arrayBuffer());

  it("admits inline types from leading bytes and keeps other bytes as attachments", async () => {
    const cases = [
      [png, "image/png", "inline"],
      [webm, "video/webm", "inline"],
      [mp4, "video/mp4", "inline"],
      [quicktime, "video/quicktime", "inline"],
      [matroska, "application/octet-stream", "attachment"],
      [text, "application/octet-stream", "attachment"],
    ] as const;
    for (const [bytes, type, kind] of cases) {
      const claims = await granted(bytes);
      const response = await serve(claims);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(type);
      expect(response.headers.get("Content-Disposition")).toMatch(
        new RegExp(`^${kind};`),
      );
      expect(response.headers.get("Content-Disposition")).toContain(
        `filename*=UTF-8''${encodeURIComponent("日本語.txt")}`,
      );
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(response.headers.get("ETag")).toBe(`"${claims.etag}"`);
      expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Length")).toBe(
        String(bytes.byteLength),
      );
      expect(await body(response)).toEqual(bytes);
    }
  });

  it("serves single byte ranges, honours validators and reports the whole representation on HEAD", async () => {
    const claims = await granted(text);
    const ranged = (range: string, extra: Record<string, string> = {}) =>
      serve(claims, { headers: { Range: range, ...extra } });
    let response = await ranged("bytes=0-3");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-3/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(await body(response)).toEqual(text.slice(0, 4));
    response = await ranged("bytes=-2");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 8-9/10");
    expect(await body(response)).toEqual(text.slice(8));
    response = await ranged("bytes=2-");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-9/10");
    expect(await body(response)).toEqual(text.slice(2));
    response = await ranged("bytes=100-");
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    expect(await response.text()).toBe("");
    for (const header of ["bytes=0-1,3-4", "bytes=abc", "bytes=5-2"]) {
      response = await ranged(header);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe("10");
      expect(await body(response)).toEqual(text);
    }
    response = await ranged("bytes=0-3", { "If-Range": `"${claims.etag}"` });
    expect(response.status).toBe(206);
    for (const validator of [
      '"other"',
      `W/"${claims.etag}"`,
      "Wed, 21 Oct 2015 07:28:00 GMT",
    ]) {
      response = await ranged("bytes=0-3", { "If-Range": validator });
      expect(response.status).toBe(200);
      expect(await body(response)).toEqual(text);
    }
    response = await serve(claims, {
      method: "HEAD",
      headers: { Range: "bytes=0-3" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(await response.text()).toBe("");
    for (const validator of [`"${claims.etag}"`, `W/"${claims.etag}"`, "*"]) {
      response = await serve(claims, {
        headers: { "If-None-Match": validator },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(`"${claims.etag}"`);
      expect(await response.text()).toBe("");
    }
    response = await serve(claims, { headers: { "If-None-Match": '"other"' } });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(text);
  });

  it("refuses a grant whose object identity no longer matches", async () => {
    const claims = await granted(text);
    expect(
      await readHttpFailure(await serve({ ...claims, etag: "other" })),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await readHttpFailure(await serve({ ...claims, version: "other" })),
    ).toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(
      await readHttpFailure(await serve({ ...claims, byteLength: 9 })),
    ).toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });
});
