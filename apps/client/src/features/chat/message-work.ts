import { apiFailure } from "@/client/api/errors";
import { MessageBodySchema, type Message } from "@vaskel/contracts/messaging";
import { errorMessage } from "@/client/api/errors";
import { message, type UiMessage } from "@/client/features/i18n/messages";
import { encodeMentions, type MentionDraft } from "./mentions";
import type { TimelineCommand } from "./reconcile";
import type { UnfinishedWorkState } from "./unfinished-work";

type Inputs = {
  edit: { draft: MentionDraft };
  delete: object;
  "remove-attachment": { attachment: Message["attachments"][number] };
};
type OperationKind = keyof Inputs;
type Intent = {
  [Kind in OperationKind]: { kind: Kind } & Inputs[Kind];
}[OperationKind];
type Preparing = Intent & { phase: "preparing" };
type Attempt = {
  [Kind in OperationKind]: { kind: Kind } & Inputs[Kind] & {
      phase: "submitting" | "retained";
      command: Extract<TimelineCommand, { operation: Kind }>;
    };
}[OperationKind];
export type MessageOperation = Preparing | Attempt;
export interface MessageWorkState {
  operation: MessageOperation | null;
  /** Reactions can report a notice independently of an inline operation. */
  error: UiMessage | null;
}
export const emptyMessageWork: MessageWorkState = {
  operation: null,
  error: null,
};
type MessageFacts = Pick<
  Message,
  "id" | "channelId" | "version" | "attachments" | "quote"
>;

/** Conversation-owned operations outlive their virtualized row views. */
export class MessageWork {
  private active = true;
  private entries = new Map<string, MessageWorkState>();
  private listeners = new Set<() => void>();
  get = (id: string): MessageWorkState =>
    this.entries.get(id) ?? emptyMessageWork;

  private publish(id: string, state: MessageWorkState) {
    if (!this.active) return;
    if (!state.operation && !state.error) this.entries.delete(id);
    else this.entries.set(id, state);
    for (const listener of this.listeners) listener();
  }
  private begin(id: string, intent: Intent, clearError = false) {
    const current = this.get(id);
    if (current.operation) return;
    this.publish(id, {
      operation: { ...intent, phase: "preparing" },
      error: clearError ? null : current.error,
    });
  }
  beginEdit(id: string, draft: MentionDraft) {
    this.begin(id, { kind: "edit", draft });
  }
  beginDelete(id: string) {
    this.begin(id, { kind: "delete" });
  }
  beginRemoval(id: string, attachment: Message["attachments"][number]) {
    this.begin(id, { kind: "remove-attachment", attachment }, true);
  }
  changeDraft(id: string, draft: MentionDraft) {
    const current = this.get(id);
    if (
      current.operation?.kind !== "edit" ||
      current.operation.phase !== "preparing"
    )
      return;
    this.publish(id, {
      ...current,
      operation: { ...current.operation, draft },
    });
  }
  setError(id: string, error: UiMessage | null) {
    this.publish(id, { ...this.get(id), error });
  }
  cancel(id: string) {
    const operation = this.get(id).operation;
    if (
      !operation ||
      operation.phase === "submitting" ||
      (operation.kind === "remove-attachment" && operation.phase === "retained")
    )
      return;
    this.publish(id, emptyMessageWork);
  }

  private prepare(current: Preparing, facts: MessageFacts): Attempt | null {
    const fields = {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      channelId: facts.channelId,
      messageId: facts.id,
      expectedVersion: facts.version,
    };
    switch (current.kind) {
      case "edit": {
        const body = encodeMentions(current.draft.body, current.draft.mentions);
        if (
          !(
            body === "" &&
            (facts.attachments.length > 0 || Boolean(facts.quote))
          ) &&
          !MessageBodySchema.safeParse(body).success
        ) {
          this.setError(facts.id, message("chat.invalidEdit"));
          return null;
        }
        return {
          ...current,
          phase: "submitting",
          command: { operation: "edit", body: { ...fields, body } },
        };
      }
      case "delete":
        return {
          ...current,
          phase: "submitting",
          command: { operation: "delete", body: fields },
        };
      case "remove-attachment":
        if (
          !facts.attachments.some(
            (file) => file.fileId === current.attachment.fileId,
          )
        )
          return null;
        return {
          ...current,
          phase: "submitting",
          command: {
            operation: "remove-attachment",
            body: { ...fields, fileId: current.attachment.fileId },
          },
        };
    }
  }

  async submit(
    facts: MessageFacts,
    execute: (command: TimelineCommand) => Promise<unknown>,
  ) {
    const current = this.get(facts.id).operation;
    if (!this.active || !current || current.phase === "submitting") return;
    const attempt =
      current.phase === "preparing"
        ? this.prepare(current, facts)
        : { ...current, phase: "submitting" as const };
    if (!attempt) return;
    this.publish(facts.id, { operation: attempt, error: null });
    try {
      await execute(attempt.command);
      // Row unmount is not retirement; the conversation still owns this result.
      if (this.active)
        this.publish(facts.id, { ...this.get(facts.id), operation: null });
    } catch (failure) {
      if (!this.active) return;
      const definite =
        apiFailure(failure) &&
        apiFailure(failure)?.failure === "http" &&
        [
          "stale_version",
          "message_unavailable",
          "invalid_input",
          "command_expired",
          "command_conflict",
        ].includes(apiFailure(failure)?.code ?? "");
      const { command: _command, phase: _phase, ...intent } = attempt;
      this.publish(facts.id, {
        operation: definite
          ? { ...intent, phase: "preparing" }
          : { ...attempt, phase: "retained" },
        error: errorMessage(failure),
      });
    }
  }

  status = (): UnfinishedWorkState => {
    let status: UnfinishedWorkState = null;
    for (const { operation } of this.entries.values()) {
      if (operation?.phase === "submitting") return "sending";
      if (operation?.phase === "retained") status = "uncertain";
      else if (operation?.kind === "edit" && status === null) status = "draft";
    }
    return status;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  attach() {
    this.active = true;
    return () => {
      this.active = false;
      // Strict Mode rehearses cleanup/setup synchronously; real retirement clears work.
      queueMicrotask(() => {
        if (!this.active) {
          this.entries.clear();
          this.listeners.clear();
        }
      });
    };
  }
}
