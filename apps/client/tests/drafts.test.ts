import { deferred } from "@tests/shared/deferred";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DraftController,
  type DraftActions,
} from "@/client/features/drafts/controller";
import type { DraftRecord } from "@/client/features/drafts/model";
import { ApiError } from "@/client/api/client";
import type { UploadTransport } from "@/client/features/files/upload-controller";
import type { SendMessage } from "@vaskel/contracts/messaging";

vi.hoisted(() => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
});
const controllers: DraftController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});
function record(): DraftRecord {
  return {
    id: crypto.randomUUID(),
    target: {
      owner: { kind: "server", id: crypto.randomUUID() },
      channelId: "channel",
      label: "General",
    },
    selectedAt: Date.now(),
    text: { body: "", mentions: [] },
    quote: null,
    files: [],
    attempt: null,
  };
}
function fixture(
  saved = record(),
  overrides: Partial<DraftActions> = {},
  files = new Map<string, File>(),
) {
  const rows = new Map<string, DraftRecord>();
  const actions: DraftActions = {
    persistent: true,
    save: vi.fn(async (value) => {
      rows.set(value.id, structuredClone(value));
      return true;
    }),
    remove: vi.fn(async (id) => {
      rows.delete(id);
      return true;
    }),
    changed: vi.fn(),
    finished: vi.fn(),
    ...overrides,
  };
  const upload: UploadTransport = {
    reserve: vi.fn(),
    upload: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(async () => {}),
  };
  const controller = new DraftController(saved, files, upload, actions);
  controllers.push(controller);
  controller.setOnline(true);
  return { controller, actions, rows, upload };
}

describe("draft-owned authoring", () => {
  it("persists the exact attempt before HTTP, and settles after its view detaches without clearing another draft", async () => {
    const disk = deferred<boolean>();
    const response = deferred<unknown>();
    const { controller, actions } = fixture(record(), {
      save: vi.fn(() => disk.promise),
    });
    const other = fixture().controller;
    controller.setText({ body: "First draft", mentions: [] });
    const detached = controller.subscribe(vi.fn());
    const send = vi.fn(() => response.promise);
    const sending = controller.submit(true, send);
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    const attempt = controller.getSnapshot().record.attempt;
    disk.resolve(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(attempt));
    detached();
    other.setText({ body: "Another conversation", mentions: [] });
    response.resolve({ kind: "accepted" });
    await sending;
    expect(actions.finished).toHaveBeenCalledOnce();
    expect(other.getSnapshot().record.text.body).toBe("Another conversation");
    expect(send).toHaveBeenCalledOnce();
  });

  it("restores an uncertain Send without changing its payload or touching its uploaded files", async () => {
    const saved = record();
    saved.text.body = "My reaction";
    const fileId = crypto.randomUUID();
    const selectedId = crypto.randomUUID();
    saved.files = [
      {
        id: selectedId,
        fileId,
        reservation: {
          commandId: crypto.randomUUID(),
          issuedAt: Date.now() - 60_000,
        },
        attachment: { fileId, filename: "meme.gif", byteLength: 4 },
      },
    ];
    saved.attempt = {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now() - 30_000,
      channelId: saved.target.channelId,
      body: saved.text.body,
      attachmentIds: [fileId],
    };
    const { controller, upload, actions } = fixture(
      saved,
      {},
      new Map([[selectedId, new File(["meme"], "meme.gif")]]),
    );
    expect(upload.status).not.toHaveBeenCalled();
    const send = vi
      .fn<(body: SendMessage) => Promise<unknown>>()
      .mockRejectedValueOnce(new ApiError("source_unavailable", 409))
      .mockResolvedValueOnce({ kind: "accepted" });
    await controller.submit(true, send);
    expect(controller.getSnapshot().record.attempt).toEqual(saved.attempt);
    controller.setText({ body: "must stay immutable", mentions: [] });
    expect(controller.getSnapshot().record.text.body).toBe("My reaction");
    await controller.submit(true, send);
    expect(send.mock.calls.map(([body]) => body)).toEqual([
      saved.attempt,
      saved.attempt,
    ]);
    expect(actions.finished).toHaveBeenCalledOnce();
    expect(upload.reserve).not.toHaveBeenCalled();
  });

  it("orders a discard after a held autosave so the draft cannot reappear", async () => {
    const disk = deferred<boolean>();
    const durable = new Map<string, DraftRecord>();
    const { controller, actions } = fixture(record(), {
      save: vi.fn(async (value) => {
        await disk.promise;
        durable.set(value.id, value);
        return true;
      }),
      remove: vi.fn(async (id) => {
        durable.delete(id);
        return true;
      }),
    });
    controller.setText({ body: "Discard while saving", mentions: [] });
    const saving = controller.flush();
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalled());
    const discarded = controller.discard();
    disk.resolve(true);
    await Promise.all([saving, discarded]);
    expect(durable.size).toBe(0);
    expect(actions.finished).toHaveBeenCalledOnce();
  });

  it("keeps editable work when storage is full and refuses to send an unrecorded persistent attempt", async () => {
    const { controller, actions } = fixture(record(), {
      save: vi.fn(async () => false),
    });
    controller.setText({ body: "Still here", mentions: [] });
    const send = vi.fn();
    await controller.submit(true, send);
    expect(send).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "authoring",
      saveFailed: true,
      record: { attempt: null, text: { body: "Still here" } },
    });
    controller.setText({ body: "Still editable", mentions: [] });
    expect(controller.needsUnloadWarning()).toBe(true);
    vi.mocked(actions.save).mockResolvedValue(true);
    await controller.flush();
    expect(controller.needsUnloadWarning()).toBe(false);
  });

  it("does not settle retired account work after a late Send response", async () => {
    const response = deferred<unknown>();
    const { controller, actions } = fixture();
    controller.setText({ body: "Old account", mentions: [] });
    const send = vi.fn(() => response.promise);
    const sending = controller.submit(true, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    controller.dispose();
    response.resolve({ kind: "accepted" });
    await sending;
    expect(actions.finished).not.toHaveBeenCalled();
  });

  it("retains a command saved before disconnection and preserves it through a later save refusal", async () => {
    const disk = deferred<boolean>();
    const { controller, actions } = fixture(record(), {
      save: vi.fn(() => disk.promise),
    });
    controller.setText({
      body: "Saved before the network paused",
      mentions: [],
    });
    const send = vi.fn();
    const sending = controller.submit(true, send);
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalled());
    const attempt = controller.getSnapshot().record.attempt;
    controller.setOnline(false);
    disk.resolve(true);
    await sending;
    expect(send).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "retained",
      uncertain: false,
      record: { attempt },
    });
    controller.setText({
      body: "Must not replace retained work",
      mentions: [],
    });
    expect(controller.getSnapshot().record.text.body).toBe(attempt?.body);

    controller.setOnline(true);
    vi.mocked(actions.save).mockResolvedValue(false);
    await controller.submit(false, send);
    expect(send).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "retained",
      uncertain: false,
      record: { attempt },
    });

    vi.mocked(actions.save).mockResolvedValue(true);
    send.mockRejectedValue(new ApiError("source_unavailable", 409));
    await controller.submit(false, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(attempt);
    // No earlier HTTP result was uncertain, so a definite refusal releases authoring.
    expect(controller.getSnapshot()).toMatchObject({
      phase: "authoring",
      record: { attempt: null },
    });
  });

  it("keeps a live ambiguous command after a later definite refusal", async () => {
    const { controller } = fixture();
    controller.setText({ body: "Possibly accepted", mentions: [] });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockRejectedValueOnce(new ApiError("source_unavailable", 409));
    await controller.submit(true, send);
    const attempt = controller.getSnapshot().record.attempt;
    await controller.submit(false, send);
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      attempt,
      attempt,
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "retained",
      uncertain: true,
      record: { attempt },
    });
  });

  it("only retries local cleanup after an accepted Send, retaining work without canceling claimed files", async () => {
    const { controller, actions, rows, upload } = fixture(record(), {
      remove: vi.fn(async () => false),
    });
    const file = new File(["meme"], "meme.gif");
    const fileId = crypto.randomUUID();
    vi.mocked(upload.reserve).mockResolvedValue(fileId);
    vi.mocked(upload.upload).mockResolvedValue({
      fileId,
      filename: file.name,
      byteLength: file.size,
    });
    controller.uploads.select([file]);
    await vi.waitFor(() =>
      expect(controller.uploads.readyAttachmentIds()).toEqual([fileId]),
    );
    const send = vi.fn(async () => ({ kind: "accepted" }));
    await controller.submit(true, send);
    await controller.flush();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "cleanup",
      outcome: "sent",
      saveFailed: true,
    });
    expect(controller.hasWork()).toBe(true);
    expect(controller.needsUnloadWarning()).toBe(true);
    expect(controller.uploads.getSnapshot()).toEqual([]);
    const attempt = controller.getSnapshot().record.attempt;
    expect(rows.get(controller.getSnapshot().record.id)?.attempt).toEqual(
      attempt,
    );
    await controller.submit(true, send);
    await controller.discard();
    expect(send).toHaveBeenCalledOnce();
    expect(upload.cancel).not.toHaveBeenCalled();
    expect(actions.finished).not.toHaveBeenCalled();

    vi.mocked(actions.remove).mockImplementation(async (id) => {
      rows.delete(id);
      return true;
    });
    await controller.retrySave();
    expect(rows.size).toBe(0);
    expect(actions.finished).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(upload.cancel).not.toHaveBeenCalled();
  });

  it("keeps an unload warning until manually cleared text is also removed from storage", async () => {
    const { controller, actions, rows } = fixture();
    controller.setText({ body: "Clear this draft", mentions: [] });
    await controller.flush();
    vi.mocked(actions.remove).mockResolvedValueOnce(false);
    controller.setText({ body: "", mentions: [] });
    await controller.flush();
    expect(controller.hasWork()).toBe(false);
    expect(controller.needsUnloadWarning()).toBe(true);
    expect(rows.size).toBe(1);
    await controller.retrySave();
    expect(rows.size).toBe(0);
    expect(controller.needsUnloadWarning()).toBe(false);
  });
});
