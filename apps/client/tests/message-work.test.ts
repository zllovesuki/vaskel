import { deferred } from "@tests/shared/deferred";
import { describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "@/client/api/errors";
import { message } from "@/client/features/i18n/messages";
import { MessageWork } from "@/client/features/chat/message-work";
import type { TimelineCommand } from "@/client/features/chat/reconcile";

const attachment = { fileId: "file", filename: "picture.png", byteLength: 4 };
const facts = {
  id: "message",
  channelId: "general",
  version: 1,
  attachments: [attachment],
};
const draft = { body: "An edit", mentions: [] };

function pendingEdit() {
  const work = new MessageWork();
  const response = deferred<void>();
  const execute = vi.fn<(command: TimelineCommand) => Promise<void>>(
    () => response.promise,
  );
  work.beginEdit(facts.id, draft);
  const submitting = work.submit(facts, execute);
  return { work, response, execute, submitting };
}

describe("inline operation ownership", () => {
  it("takes current message facts at first Submit and retains the exact command across retries", async () => {
    const work = new MessageWork();
    work.beginEdit(facts.id, draft);
    work.changeDraft(facts.id, { body: "", mentions: [] });
    const execute = vi
      .fn<(command: TimelineCommand) => Promise<void>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce();
    await work.submit({ ...facts, version: 4 }, execute);
    const command = execute.mock.calls[0]![0];
    expect(command).toMatchObject({
      operation: "edit",
      body: { expectedVersion: 4, body: "" },
    });
    expect(work.get(facts.id).operation).toMatchObject({
      kind: "edit",
      phase: "retained",
      command,
    });
    work.changeDraft(facts.id, draft);
    // Replay can remove the attachment that originally permitted an empty caption.
    // The original attempt does not become a fresh edit against those newer facts.
    await work.submit({ ...facts, version: 5, attachments: [] }, execute);
    expect(execute.mock.calls[1]![0]).toBe(command);
    expect(work.get(facts.id).operation).toBeNull();
  });

  it("rejects an invalid fresh edit without freezing it, then sends the correction", async () => {
    const work = new MessageWork();
    const execute = vi.fn(async (_command: TimelineCommand) => {});
    work.beginEdit(facts.id, { body: "", mentions: [] });
    await work.submit({ ...facts, attachments: [] }, execute);
    expect(execute).not.toHaveBeenCalled();
    expect(work.get(facts.id)).toMatchObject({
      operation: { phase: "preparing" },
      error: message("chat.invalidEdit"),
    });
    work.changeDraft(facts.id, draft);
    await work.submit({ ...facts, attachments: [] }, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(work.get(facts.id).operation).toBeNull();
  });

  it("returns definite failures to preparation and creates a new command for corrected work", async () => {
    const work = new MessageWork();
    const execute = vi
      .fn<(command: TimelineCommand) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError("stale_version", 409))
      .mockResolvedValueOnce();
    work.beginEdit(facts.id, draft);
    await work.submit(facts, execute);
    expect(work.get(facts.id).operation).toMatchObject({
      kind: "edit",
      phase: "preparing",
      draft,
    });
    expect(work.get(facts.id).operation).not.toHaveProperty("command");
    work.changeDraft(facts.id, { body: "Updated edit", mentions: [] });
    await work.submit({ ...facts, version: 2 }, execute);
    expect(execute.mock.calls[1]![0].body.commandId).not.toBe(
      execute.mock.calls[0]![0].body.commandId,
    );
    expect(execute.mock.calls[1]![0]).toMatchObject({
      operation: "edit",
      body: { expectedVersion: 2, body: "Updated edit" },
    });
  });

  it("refuses replacement, cancellation, changes and a second request while submission is pending", async () => {
    const { work, response, execute, submitting } = pendingEdit();
    const original = work.get(facts.id).operation;
    work.beginDelete(facts.id);
    work.beginRemoval(facts.id, attachment);
    work.changeDraft(facts.id, { body: "Changed", mentions: [] });
    work.cancel(facts.id);
    await work.submit(facts, execute);
    expect(work.get(facts.id).operation).toBe(original);
    expect(execute).toHaveBeenCalledOnce();
    response.resolve();
    await submitting;
    expect(work.status()).toBeNull();
  });

  it("finishes after a row unsubscribes and retains a concurrent reaction notice", async () => {
    const { work, response, submitting } = pendingEdit();
    const unsubscribe = work.subscribe(vi.fn());
    work.setError(facts.id, message("chat.messageUnavailable"));
    expect(work.status()).toBe("sending");
    unsubscribe();
    response.resolve();
    await submitting;
    expect(work.get(facts.id)).toEqual({
      operation: null,
      error: message("chat.messageUnavailable"),
    });
    expect(work.status()).toBeNull();
    work.setError(facts.id, null);
    expect(work.get(facts.id)).toEqual({ operation: null, error: null });
  });

  it.each(["edit", "delete"] as const)(
    "can abandon a retained %s without turning it into another command",
    async (kind) => {
      const work = new MessageWork();
      const execute = vi.fn(async (_command: TimelineCommand) => {
        throw new NetworkError();
      });
      if (kind === "edit") work.beginEdit(facts.id, draft);
      else work.beginDelete(facts.id);
      await work.submit(facts, execute);
      expect(work.status()).toBe("uncertain");
      work.cancel(facts.id);
      expect(work.get(facts.id)).toEqual({ operation: null, error: null });
      expect(work.status()).toBeNull();
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("keeps a retained removal and its selected label when replay no longer contains the file", async () => {
    const work = new MessageWork();
    const execute = vi
      .fn<(command: TimelineCommand) => Promise<void>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce();
    work.beginRemoval(facts.id, attachment);
    await work.submit(facts, execute);
    const retained = work.get(facts.id).operation;
    expect(retained).toMatchObject({
      kind: "remove-attachment",
      phase: "retained",
      attachment,
      command: {
        operation: "remove-attachment",
        body: { fileId: attachment.fileId },
      },
    });
    work.cancel(facts.id);
    expect(work.get(facts.id).operation).toBe(retained);
    await work.submit({ ...facts, version: 2, attachments: [] }, execute);
    expect(execute.mock.calls[1]![0]).toBe(execute.mock.calls[0]![0]);
    expect(work.get(facts.id).operation).toBeNull();
  });

  it("allows canceling a preparing removal and refuses a fresh removal after the file disappeared", async () => {
    const work = new MessageWork();
    const execute = vi.fn(async (_command: TimelineCommand) => {});
    work.setError(facts.id, message("chat.invalidEdit"));
    work.beginRemoval(facts.id, attachment);
    expect(work.get(facts.id).error).toBeNull();
    expect(work.status()).toBeNull();
    await work.submit({ ...facts, attachments: [] }, execute);
    expect(execute).not.toHaveBeenCalled();
    work.cancel(facts.id);
    expect(work.get(facts.id).operation).toBeNull();
  });

  it("rejects late results and notices after conversation retirement", async () => {
    const { work, response, submitting } = pendingEdit();
    const listener = vi.fn();
    work.subscribe(listener);
    const detach = work.attach();
    detach();
    work.setError(facts.id, message("chat.invalidEdit"));
    response.reject(new NetworkError());
    await submitting;
    expect(listener).not.toHaveBeenCalled();
    expect(work.get(facts.id)).toEqual({ operation: null, error: null });
  });

  it("preserves operation state through synchronous React effect cleanup/setup", async () => {
    const { work, response, submitting } = pendingEdit();
    const listener = vi.fn();
    work.subscribe(listener);
    work.attach()();
    const detach = work.attach();
    await Promise.resolve();
    expect(work.status()).toBe("sending");
    response.resolve();
    await submitting;
    expect(listener).toHaveBeenCalledOnce();
    expect(work.status()).toBeNull();
    detach();
  });
});
