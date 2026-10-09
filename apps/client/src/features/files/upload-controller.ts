import { COMMAND_RETRY_MS } from "@vaskel/contracts/messaging";
import { errorMessage } from "@/client/api/errors";
import {
  message,
  UiMessageError,
  type UiMessage,
} from "@/client/features/i18n/messages";
import {
  ATTACHMENT_BYTE_LIMIT,
  MESSAGE_ATTACHMENT_LIMIT,
  type AttachmentDescriptor,
} from "@vaskel/contracts/attachments";

export interface UploadTransport {
  reserve: (
    file: File,
    signal: AbortSignal,
    command: { commandId: string; issuedAt: number },
  ) => Promise<string>;
  upload: (
    fileId: string,
    file: File,
    signal: AbortSignal,
  ) => Promise<AttachmentDescriptor>;
  status: (
    fileId: string,
    signal: AbortSignal,
  ) => Promise<AttachmentDescriptor | null>;
  cancel: (fileId: string, signal: AbortSignal) => Promise<void>;
}
/** Saved metadata and selected bytes; restoration never supplies runtime phases. */
export interface RestoredSelection {
  id: string;
  file: File;
  reservation: { commandId: string; issuedAt: number };
  fileId?: string | undefined;
  /** Last confirmed descriptor, retained while status is checked again. */
  attachment?: AttachmentDescriptor | undefined;
}
type UploadStatus =
  | { phase: "uploading" | "checking"; error?: never }
  | { phase: "ready"; attachment: AttachmentDescriptor; error?: never }
  | { phase: "error"; error: UiMessage };
export type SelectedFile = RestoredSelection & UploadStatus;

/** Owns local file bytes and request lifetimes, never accepted message state. */
export class UploadController {
  private items: SelectedFile[] = [];
  private listeners = new Set<() => void>();
  private requests = new Map<string, AbortController>();
  private active = true;
  private locked = false;
  private online = true;
  constructor(
    private readonly transport: UploadTransport,
    items: RestoredSelection[] = [],
  ) {
    this.items = items.map((item) => ({
      ...item,
      ...(item.attachment
        ? { phase: "ready" as const, attachment: item.attachment }
        : { phase: "error" as const, error: message("files.interrupted") }),
    }));
  }
  getSnapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.active = true;
  }
  /** Stop request work without discarding selected bytes or an exact send attempt. */
  setOnline(online: boolean) {
    this.online = online;
    if (online) return;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.items = this.items.map((item) =>
      item.phase === "uploading" || item.phase === "checking"
        ? {
            ...item,
            phase: "error",
            error: message("files.interrupted"),
          }
        : item,
    );
    this.publish();
  }
  /** Restored drafts verify retained uploads; network work is never serialized. */
  async recheck() {
    if (!this.active || !this.online || this.locked) return;
    await Promise.all(
      this.items.map(async (item) => {
        if (this.requests.has(item.id)) return;
        const request = new AbortController();
        this.requests.set(item.id, request);
        if (item.fileId) await this.resolve(item.id, item.fileId, request);
        else
          this.update(item.id, {
            phase: "error",
            error: message("files.interrupted"),
          });
        if (this.requests.get(item.id) === request)
          this.requests.delete(item.id);
      }),
    );
  }
  async discard() {
    const ids = this.items.flatMap((item) =>
      item.fileId ? [item.fileId] : [],
    );
    this.dispose();
    await Promise.allSettled(
      ids.map((id) => this.transport.cancel(id, AbortSignal.timeout(10_000))),
    );
  }
  dispose() {
    this.active = false;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.items = [];
    this.locked = false;
  }
  private publish() {
    for (const listener of this.listeners) listener();
  }
  private current(id: string, request: AbortController) {
    return (
      this.active &&
      this.online &&
      !request.signal.aborted &&
      this.requests.get(id) === request
    );
  }
  private update(id: string, status: UploadStatus & { fileId?: string }) {
    this.items = this.items.map((item) => {
      if (item.id !== id) return item;
      const { phase: _phase, error: _error, ...retained } = item;
      return { ...retained, ...status };
    });
    this.publish();
  }
  select(files: File[]): UiMessage | null {
    if (!this.active || !this.online || this.locked) return null;
    if (this.items.length + files.length > MESSAGE_ATTACHMENT_LIMIT)
      return message("files.selectionLimit");
    if (
      files.some((file) => file.size < 1 || file.size > ATTACHMENT_BYTE_LIMIT)
    )
      return message("files.sizeLimit");
    const added = files.map((file): SelectedFile => ({
      id: crypto.randomUUID(),
      reservation: { commandId: crypto.randomUUID(), issuedAt: Date.now() },
      file,
      phase: "uploading",
    }));
    this.items = [...this.items, ...added];
    this.publish();
    for (const item of added) void this.start(item);
    return null;
  }
  private async start(item: SelectedFile) {
    const request = new AbortController();
    this.requests.set(item.id, request);
    try {
      const fileId = await this.transport.reserve(
        item.file,
        request.signal,
        item.reservation,
      );
      if (!this.current(item.id, request)) return;
      this.update(item.id, { phase: "uploading", fileId });
      try {
        const attachment = await this.transport.upload(
          fileId,
          item.file,
          request.signal,
        );
        if (this.current(item.id, request))
          this.update(item.id, { phase: "ready", attachment });
      } catch {
        if (this.current(item.id, request))
          await this.resolve(item.id, fileId, request);
      }
    } catch (error) {
      if (this.current(item.id, request))
        this.update(item.id, {
          phase: "error",
          error: errorMessage(error),
        });
    } finally {
      if (this.requests.get(item.id) === request) this.requests.delete(item.id);
    }
  }
  private async resolve(id: string, fileId: string, request: AbortController) {
    this.update(id, { phase: "checking" });
    try {
      const attachment = await this.transport.status(fileId, request.signal);
      if (!this.current(id, request)) return;
      this.update(
        id,
        attachment
          ? { phase: "ready", attachment }
          : {
              phase: "error",
              error: message("files.unconfirmed"),
            },
      );
    } catch (error) {
      if (this.current(id, request))
        this.update(id, {
          phase: "error",
          error: errorMessage(error),
        });
    } finally {
      if (this.requests.get(id) === request) this.requests.delete(id);
    }
  }
  check(id: string) {
    const item = this.items.find((item) => item.id === id);
    if (
      !this.active ||
      !this.online ||
      this.locked ||
      !item?.fileId ||
      item.phase !== "error"
    )
      return;
    this.requests.get(id)?.abort();
    const request = new AbortController();
    this.requests.set(id, request);
    void this.resolve(id, item.fileId, request);
  }
  async retry(id: string) {
    const item = this.items.find((item) => item.id === id);
    if (!this.active || !this.online || this.locked || item?.phase !== "error")
      return;
    this.requests.get(id)?.abort();
    const request = new AbortController();
    this.requests.set(id, request);
    this.update(id, { phase: "checking" });
    try {
      // Retire a known writer first; an unlocated reservation beyond the retry horizon has expired.
      if (item.fileId) await this.transport.cancel(item.fileId, request.signal);
      if (!this.current(id, request)) return;
      const next: SelectedFile = {
        id,
        file: item.file,
        phase: "uploading",
        reservation:
          item.fileId ||
          item.reservation.issuedAt < Date.now() - COMMAND_RETRY_MS
            ? { commandId: crypto.randomUUID(), issuedAt: Date.now() }
            : item.reservation,
      };
      this.items = this.items.map((item) => (item.id === id ? next : item));
      this.publish();
      await this.start(next);
    } catch (error) {
      if (this.current(id, request))
        this.update(id, {
          phase: "error",
          error: errorMessage(error),
        });
    }
  }
  remove(id: string) {
    if (!this.active || !this.online || this.locked) return;
    const item = this.items.find((item) => item.id === id);
    if (!item) return;
    this.requests.get(id)?.abort();
    this.requests.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    this.publish();
    if (item.fileId) {
      const request = new AbortController();
      this.requests.set(id, request);
      // Discard is best effort; owner deadlines cover interrupted cleanup.
      void this.transport
        .cancel(item.fileId, request.signal)
        .catch(() => {})
        .finally(() => {
          if (this.requests.get(id) === request) this.requests.delete(id);
        });
    }
  }
  /** Readiness has one owner, including restored descriptors held by an exact Send. */
  readyAttachmentIds(): string[] | null {
    const ids: string[] = [];
    for (const item of this.items) {
      if (item.phase !== "ready") return null;
      ids.push(item.attachment.fileId);
    }
    return ids;
  }
  freeze(): string[] {
    const ids = this.readyAttachmentIds();
    if (!this.active || !this.online || this.locked || !ids)
      throw new UiMessageError(message("files.notReady"));
    this.locked = true;
    return ids;
  }
  accepted() {
    this.locked = false;
    this.items = [];
    this.requests.clear();
    this.publish();
  }
  unlock() {
    this.locked = false;
  }
}
