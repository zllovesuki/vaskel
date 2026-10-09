import type { UiMessage } from "@/client/features/i18n/messages";
import type { SendMessage } from "@vaskel/contracts/messaging";
import type { QuoteSelection } from "@/client/features/chat/quote-selection";
import type { DraftRecord } from "./model";

/** The command lives only in record.attempt, including local cleanup after Send. */
export type DraftSubmission =
  | { phase: "authoring"; record: DraftRecord & { attempt: null } }
  | {
      phase: "submitting" | "retained";
      record: DraftRecord & { attempt: SendMessage };
      uncertain: boolean;
    }
  | {
      phase: "cleanup";
      record: DraftRecord & { attempt: SendMessage };
      outcome: "sent";
    }
  | {
      phase: "cleanup";
      record: DraftRecord;
      outcome: "discarded";
    };

export interface DraftPresentation {
  error: UiMessage | null;
  saving: boolean;
  saveFailed: boolean;
  preview: QuoteSelection | null;
}
export type DraftState = DraftSubmission & DraftPresentation;

export function restoredSubmission(record: DraftRecord): DraftSubmission {
  return record.attempt
    ? {
        phase: "retained",
        record: { ...record, attempt: record.attempt },
        uncertain: true,
      }
    : { phase: "authoring", record: { ...record, attempt: null } };
}

/** Metadata edits cannot create, replace or clear a submission's exact command. */
export function updateDraftMetadata(
  state: DraftState,
  patch: Partial<Omit<DraftRecord, "attempt">>,
): DraftState {
  switch (state.phase) {
    case "authoring":
      return { ...state, record: { ...state.record, ...patch } };
    case "submitting":
    case "retained":
      return { ...state, record: { ...state.record, ...patch } };
    case "cleanup":
      return state;
  }
}
