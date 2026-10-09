import { fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  UploadController,
  type UploadTransport,
} from "@/client/features/files/upload-controller";
import { ATTACHMENT_BYTE_LIMIT } from "@vaskel/contracts/attachments";

let uploadTransport: typeof import("@/client/features/files/transport").uploadTransport;
const owner = { kind: "server", id: "server-a" } as const;
const file = new File(["日本語 content"], "共有資料.txt", {
  type: "text/plain",
});
const fileId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const attachment = { fileId, filename: file.name, byteLength: file.size };

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  ({ uploadTransport } = await import("@/client/features/files/transport"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function transport(): UploadTransport {
  return {
    reserve: vi.fn(async () => fileId),
    upload: vi.fn(async () => attachment),
    status: vi.fn(async () => attachment),
    cancel: vi.fn(async () => {}),
  };
}

describe("private attachment selection and transport", () => {
  it("recovers a lost PUT response by status, sends the browser File directly and never repeats PUT", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ kind: "attachment_reserved", fileId, expiresAt: 100 }),
      )
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(
        Response.json({
          kind: "attachment_status",
          state: "ready",
          attachment,
          expiresAt: 100,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const controller = new UploadController(
      uploadTransport(owner, "channel-a"),
    );
    controller.select([file]);
    await vi.waitFor(() =>
      expect(controller.getSnapshot()[0]?.phase).toBe("ready"),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      await fetchRequest(
        fetch.mock.calls[0]![0] as RequestInfo,
        fetch.mock.calls[0]![1] as RequestInit,
      ).json(),
    ).toMatchObject({
      channelId: "channel-a",
      filename: "共有資料.txt",
      byteLength: file.size,
    });
    expect(fetch.mock.calls[1]).toEqual([
      `/api/resources/server/server-a/files/${fileId}/content`,
      expect.objectContaining({
        method: "PUT",
        body: file,
        credentials: "same-origin",
      }),
    ]);
    expect(
      new URL(
        fetchRequest(
          fetch.mock.calls[2]![0] as RequestInfo,
          fetch.mock.calls[2]![1] as RequestInit,
        ).url,
      ).pathname,
    ).toBe(`/api/resources/server/server-a/files/${fileId}/status`);
    expect(controller.freeze()).toEqual([fileId]);
    // An ambiguous send retains its files for exact receipt recovery. No discard is issued.
    controller.remove(controller.getSnapshot()[0]!.id);
    controller.select([file]);
    expect(controller.getSnapshot()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    controller.accepted();
    expect(controller.getSnapshot()).toEqual([]);
    controller.dispose();
  });

  it("retries an ambiguous reservation with its exact command", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("reservation response lost"))
      .mockResolvedValueOnce(
        Response.json({ kind: "attachment_reserved", fileId, expiresAt: 100 }),
      )
      .mockResolvedValueOnce(
        Response.json({ kind: "attachment_ready", attachment, expiresAt: 100 }),
      );
    vi.stubGlobal("fetch", fetch);
    const controller = new UploadController(
      uploadTransport(owner, "channel-a"),
    );
    controller.select([file]);
    await vi.waitFor(() =>
      expect(controller.getSnapshot()[0]?.phase).toBe("error"),
    );
    controller.setOnline(false);
    controller.setOnline(true);
    await controller.retry(controller.getSnapshot()[0]!.id);
    expect(
      await fetchRequest(
        fetch.mock.calls[1]![0] as RequestInfo,
        fetch.mock.calls[1]![1] as RequestInit,
      ).json(),
    ).toEqual(
      await fetchRequest(
        fetch.mock.calls[0]![0] as RequestInfo,
        fetch.mock.calls[0]![1] as RequestInit,
      ).json(),
    );
    expect(controller.getSnapshot()[0]?.phase).toBe("ready");
    controller.dispose();
  });

  it("checks an unresolved writer again without uploading the old key", async () => {
    const api = transport();
    vi.mocked(api.upload).mockRejectedValue(new Error("lost"));
    vi.mocked(api.status).mockResolvedValueOnce(null);
    const controller = new UploadController(api);
    controller.select([file]);
    await vi.waitFor(() =>
      expect(controller.getSnapshot()[0]).toMatchObject({
        phase: "error",
        fileId,
      }),
    );
    expect(() => controller.freeze()).toThrow("files.notReady");
    controller.check(controller.getSnapshot()[0]!.id);
    await vi.waitFor(() =>
      expect(controller.getSnapshot()[0]?.phase).toBe("ready"),
    );
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("retires the previous attempt before reserving a fresh writer on retry", async () => {
    const api = transport();
    const canceled = deferred<void>();
    vi.mocked(api.reserve)
      .mockResolvedValueOnce(fileId)
      .mockResolvedValueOnce(secondId);
    vi.mocked(api.upload)
      .mockRejectedValueOnce(new Error("broken"))
      .mockResolvedValueOnce({ ...attachment, fileId: secondId });
    vi.mocked(api.status).mockRejectedValueOnce(new Error("unavailable"));
    vi.mocked(api.cancel).mockReturnValueOnce(canceled.promise);
    const controller = new UploadController(api);
    controller.select([file]);
    await vi.waitFor(() =>
      expect(controller.getSnapshot()[0]?.phase).toBe("error"),
    );
    const retry = controller.retry(controller.getSnapshot()[0]!.id);
    expect(api.cancel).toHaveBeenCalledWith(fileId, expect.any(AbortSignal));
    expect(api.reserve).toHaveBeenCalledTimes(1);
    canceled.resolve();
    await retry;
    expect(controller.freeze()).toEqual([secondId]);
    expect(vi.mocked(api.upload).mock.calls.map(([id]) => id)).toEqual([
      fileId,
      secondId,
    ]);
    controller.dispose();
  });

  it("does not reserve again when cancellation reports an accepted claim", async () => {
    const api = transport();
    vi.mocked(api.upload).mockRejectedValue(new Error("lost"));
    vi.mocked(api.status).mockRejectedValue(new Error("unavailable"));
    vi.mocked(api.cancel).mockRejectedValue(
      new UiMessageError(message("files.alreadySent")),
    );
    const controller = new UploadController(api);
    controller.select([file]);
    await vi.waitFor(() =>
      expect(controller.getSnapshot()[0]?.phase).toBe("error"),
    );
    await controller.retry(controller.getSnapshot()[0]!.id);
    expect(api.reserve).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()[0]?.error).toEqual(
      message("files.alreadySent"),
    );
    controller.dispose();
  });

  it("aborts canceled uploads and fences their delayed success", async () => {
    const api = transport();
    const uploaded = deferred<typeof attachment>();
    vi.mocked(api.upload).mockReturnValue(uploaded.promise);
    const controller = new UploadController(api);
    controller.select([file]);
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
    controller.remove(controller.getSnapshot()[0]!.id);
    expect(vi.mocked(api.upload).mock.calls[0]![2].aborted).toBe(true);
    expect(api.cancel).toHaveBeenCalledWith(fileId, expect.any(AbortSignal));
    uploaded.resolve(attachment);
    await uploaded.promise;
    expect(controller.getSnapshot()).toEqual([]);
    controller.dispose();
  });

  it("cannot start a delayed reservation's upload after account or channel teardown", async () => {
    const api = transport();
    const reserved = deferred<string>();
    vi.mocked(api.reserve).mockReturnValue(reserved.promise);
    const controller = new UploadController(api);
    controller.select([file]);
    controller.dispose();
    // React's StrictMode can activate the same controller again; aborted work remains fenced.
    controller.activate();
    reserved.resolve(fileId);
    await reserved.promise;
    expect(api.upload).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual([]);
    controller.dispose();
  });

  it("rejects oversized, empty and excessive selection before reserving bytes", () => {
    const api = transport();
    const controller = new UploadController(api);
    expect(controller.select([new File([], "empty.txt")])).toEqual(
      message("files.sizeLimit"),
    );
    expect(
      controller.select([
        new File([new Uint8Array(ATTACHMENT_BYTE_LIMIT + 1)], "large.txt"),
      ]),
    ).toEqual(message("files.sizeLimit"));
    expect(controller.select(Array.from({ length: 5 }, () => file))).toEqual(
      message("files.selectionLimit"),
    );
    expect(api.reserve).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual([]);
    controller.dispose();
  });

  it("normalizes restored metadata and withholds readiness until an ordinary status recheck settles", async () => {
    const api = transport();
    const checked = deferred<typeof attachment | null>();
    vi.mocked(api.status).mockReturnValueOnce(checked.promise);
    const selectedId = crypto.randomUUID();
    const reservation = {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    };
    const controller = new UploadController(api, [
      { id: selectedId, file, reservation, fileId, attachment },
    ]);
    expect(controller.readyAttachmentIds()).toEqual([fileId]);
    const checking = controller.recheck();
    expect(controller.getSnapshot()[0]?.phase).toBe("checking");
    expect(controller.readyAttachmentIds()).toBeNull();
    expect(() => controller.freeze()).toThrow("files.notReady");
    checked.resolve(null);
    await checking;
    expect(controller.getSnapshot()[0]).toMatchObject({
      phase: "error",
      fileId,
      reservation,
      file,
    });
    expect(controller.readyAttachmentIds()).toBeNull();
    controller.check(selectedId);
    await vi.waitFor(() =>
      expect(controller.readyAttachmentIds()).toEqual([fileId]),
    );
    expect(api.reserve).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
    controller.dispose();
  });
});

it("retries an old saved file with a fresh reservation and can recheck a completed upload", async () => {
  const reservation = {
    commandId: crypto.randomUUID(),
    issuedAt: Date.now() - 48 * 60 * 60_000,
  };
  const selectedId = crypto.randomUUID();
  const api: UploadTransport = {
    reserve: vi.fn(async () => fileId),
    upload: vi.fn(async () => attachment),
    status: vi.fn(async () => attachment),
    cancel: vi.fn(async () => {}),
  };
  const controller = new UploadController(api, [
    { id: selectedId, reservation, file },
  ]);
  await controller.retry(selectedId);
  expect(vi.mocked(api.reserve).mock.calls[0]?.[2].commandId).not.toBe(
    reservation.commandId,
  );
  expect(controller.getSnapshot()[0]).toMatchObject({
    file,
    phase: "ready",
    attachment,
  });
  await controller.recheck();
  expect(api.status).toHaveBeenCalledWith(fileId, expect.any(AbortSignal));
  expect(controller.getSnapshot()[0]?.phase).toBe("ready");
  controller.dispose();
});

describe("live upload disconnection", () => {
  it("keeps selected bytes, rejects delayed PUT completion, and only checks status after explicit action", async () => {
    const file = new File(["contents"], "notes.txt");
    const attachment = {
      fileId: crypto.randomUUID(),
      filename: file.name,
      byteLength: file.size,
    };
    const held = deferred<typeof attachment>();
    const transport: UploadTransport = {
      reserve: vi.fn(async () => attachment.fileId),
      upload: vi.fn(() => held.promise),
      status: vi.fn(async () => attachment),
      cancel: vi.fn(async () => {}),
    };
    const uploads = new UploadController(transport);
    uploads.select([file]);
    await vi.waitFor(() => expect(transport.upload).toHaveBeenCalledOnce());
    const id = uploads.getSnapshot()[0]!.id;
    uploads.setOnline(false);
    held.resolve(attachment);
    await Promise.resolve();
    expect(uploads.getSnapshot()[0]).toMatchObject({
      file,
      phase: "error",
      fileId: attachment.fileId,
    });
    uploads.setOnline(true);
    expect(transport.reserve).toHaveBeenCalledOnce();
    expect(transport.upload).toHaveBeenCalledOnce();
    expect(transport.status).not.toHaveBeenCalled();
    uploads.check(id);
    await vi.waitFor(() =>
      expect(uploads.getSnapshot()[0]?.phase).toBe("ready"),
    );
    expect(uploads.freeze()).toEqual([attachment.fileId]);
    uploads.setOnline(false);
    uploads.setOnline(true);
    uploads.remove(id);
    expect(uploads.getSnapshot()).toHaveLength(1);
    expect(transport.cancel).not.toHaveBeenCalled();
    uploads.dispose();
  });
});
