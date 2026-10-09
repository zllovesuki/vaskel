import { message, type UiMessage } from "@/client/features/i18n/messages";
import { errorMessage } from "@/client/api/client";
import {
  SendMessageSchema,
  type SendMessage,
} from "@vaskel/contracts/messaging";
import {
  encodeMentions,
  type MentionDraft,
} from "@/client/features/chat/mentions";
import { isDefiniteSendRejection } from "@/client/features/chat/mutation-failure";
import type { QuoteSelection } from "@/client/features/chat/quote-selection";
import {
  UploadController,
  type UploadTransport,
} from "@/client/features/files/upload-controller";
import type { DraftRecord } from "./model";
import {
  restoredSubmission,
  updateDraftMetadata,
  type DraftPresentation,
  type DraftState,
  type DraftSubmission,
} from "./state";
export type { DraftState } from "./state";

export interface DraftActions {
  save(record: DraftRecord, files: ReadonlyMap<string, File>): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  persistent: boolean;
  finished(): void;
  changed(): void;
}

/** Owns one message's work independently of its mounted composer. */
export class DraftController {
  readonly uploads: UploadController;
  private state: DraftState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<boolean> = Promise.resolve(true);
  private serial = 0;
  private savedSerial = 0;
  private active = true;
  private online = false;
  private stopUploads: () => void;
  constructor(
    record: DraftRecord,
    files: ReadonlyMap<string, File>,
    transport: UploadTransport,
    private actions: DraftActions,
  ) {
    this.state = {
      ...restoredSubmission(record),
      error: record.attempt ? message("chat.uncertainSend") : null,
      saving: false,
      saveFailed: false,
      preview: null,
    };
    this.uploads = new UploadController(
      transport,
      record.files.map((saved) => {
        const file = files.get(saved.id);
        if (!file) throw new Error("Missing saved draft attachment.");
        return { ...saved, file };
      }),
    );
    if (record.attempt) this.uploads.freeze();
    this.stopUploads = this.uploads.subscribe(() => {
      if (!this.active || this.state.phase === "cleanup") return;
      this.update({
        files: this.uploads
          .getSnapshot()
          .map(({ id, reservation, fileId, attachment }) => ({
            id,
            reservation,
            ...(fileId ? { fileId } : {}),
            ...(attachment ? { attachment } : {}),
          })),
      });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<DraftPresentation>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    this.actions.changed();
  }
  private transition(submission: DraftSubmission) {
    const { error, saving, saveFailed, preview } = this.state;
    this.state = { ...submission, error, saving, saveFailed, preview };
    this.publish({});
  }
  private changedRecord() {
    this.serial++;
    this.publish({ saving: true });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 250);
  }
  private update(patch: Partial<Omit<DraftRecord, "attempt">>) {
    if (!this.active || this.state.phase === "cleanup") return;
    this.state = updateDraftMetadata(this.state, patch);
    this.changedRecord();
  }
  private authoring(record: DraftRecord) {
    this.uploads.unlock();
    this.transition({
      phase: "authoring",
      record: { ...record, attempt: null },
    });
    this.changedRecord();
  }
  hasWork = () =>
    Boolean(
      this.state.record.text.body ||
      this.state.record.quote ||
      this.state.record.files.length ||
      this.state.record.attempt,
    );
  needsUnloadWarning = () =>
    this.serial !== this.savedSerial || this.state.saveFailed;
  setText = (text: MentionDraft) => {
    if (this.state.phase !== "authoring") return;
    this.update({ text: { body: text.body, mentions: [...text.mentions] } });
  };
  setQuote(selection: QuoteSelection | null) {
    if (this.state.phase !== "authoring") return;
    this.publish({ preview: selection });
    this.update({ quote: selection?.reference ?? null });
  }
  select() {
    this.update({ selectedAt: Date.now() });
  }
  setError = (error: UiMessage | null) => this.publish({ error });
  setOnline(online: boolean) {
    if (this.online === online || !this.active) return;
    this.online = online;
    this.uploads.setOnline(online);
    if (online && this.state.phase === "authoring") void this.uploads.recheck();
  }
  clearPreview() {
    if (this.state.preview) this.publish({ preview: null });
  }
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.tail = this.tail
      .then(async () => {
        if (!this.active) return false;
        const serial = this.serial;
        const record = this.state.record;
        const files = new Map(
          this.uploads.getSnapshot().map((item) => [item.id, item.file]),
        );
        const saved =
          this.state.phase === "cleanup" || !this.hasWork()
            ? await this.actions.remove(record.id)
            : await this.actions.save(record, files);
        if (!this.active) return false;
        if (saved) this.savedSerial = serial;
        this.publish({ saving: this.serial !== serial, saveFailed: !saved });
        return saved;
      })
      .catch(() => {
        if (this.active) this.publish({ saving: false, saveFailed: true });
        return false;
      });
    return this.tail;
  };
  async submit(
    canSend: boolean,
    send: (command: SendMessage) => Promise<unknown>,
  ) {
    const initial = this.state;
    if (
      !this.active ||
      !this.online ||
      (initial.phase !== "authoring" && initial.phase !== "retained") ||
      (initial.phase === "authoring" && !canSend)
    )
      return;
    const fresh = initial.phase === "authoring";
    const attachmentIds = fresh ? this.uploads.readyAttachmentIds() : [];
    if (!attachmentIds) {
      this.setError(message("chat.waitForUploads"));
      return;
    }
    const record = initial.record;
    const parsed = SendMessageSchema.safeParse(
      initial.phase === "retained"
        ? initial.record.attempt
        : {
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
            channelId: record.target.channelId,
            body: record.text.body.trim()
              ? encodeMentions(record.text.body, record.text.mentions)
              : "",
            attachmentIds,
            ...(record.quote ? { quote: record.quote } : {}),
          },
    );
    if (!parsed.success) {
      this.setError(message("chat.invalidMessage"));
      return;
    }
    if (fresh) this.uploads.freeze();
    const submitting = {
      phase: "submitting" as const,
      record: { ...record, attempt: parsed.data },
      uncertain: initial.phase === "retained" && initial.uncertain,
    };
    this.transition(submitting);
    this.changedRecord();
    this.publish({ error: null });
    try {
      // An accepted-but-unobserved send must restore its exact identity after reload.
      if (!(await this.flush()) && this.actions.persistent) {
        if (!this.active) return;
        if (fresh) this.authoring(this.state.record);
        this.setError(message("drafts.saveBeforeSend"));
        return;
      }
      if (!this.active || !this.online) return;
      await send(parsed.data);
      if (!this.active) return;
      this.transition({
        phase: "cleanup",
        outcome: "sent",
        record: { ...this.state.record, attempt: parsed.data },
      });
      this.publish({ error: null });
      this.uploads.accepted();
      await this.finish();
    } catch (failure) {
      if (!this.active || this.state.phase === "cleanup") return;
      this.setError(errorMessage(failure));
      if (isDefiniteSendRejection(failure, submitting.uncertain)) {
        this.authoring(this.state.record);
        void this.uploads.recheck();
      } else {
        this.transition({
          phase: "retained",
          record: { ...this.state.record, attempt: parsed.data },
          uncertain: true,
        });
      }
    } finally {
      if (this.active) {
        // Saved before going offline is retained too, even if HTTP never started.
        // Cleanup and definite rejection have already left the submitting state.
        if (this.state.phase === "submitting")
          this.transition({ ...this.state, phase: "retained" });
        void this.flush();
      }
    }
  }
  private async finish() {
    if ((await this.flush()) && this.active) this.actions.finished();
  }
  retrySave = async () => {
    if (this.state.phase === "cleanup") await this.finish();
    else await this.flush();
  };
  async discard() {
    if (this.state.phase === "submitting" || this.state.phase === "cleanup")
      return;
    this.transition({
      phase: "cleanup",
      outcome: "discarded",
      record: this.state.record,
    });
    void this.uploads.discard();
    await this.finish();
  }
  dispose() {
    this.active = false;
    clearTimeout(this.timer);
    this.stopUploads();
    this.uploads.dispose();
    this.listeners.clear();
  }
}
