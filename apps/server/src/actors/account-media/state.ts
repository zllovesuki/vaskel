import { z } from "zod";
import {
  MediaEndReasonSchema,
  MediaRoomRefSchema,
  type AccountMediaOutcome,
  type MediaEndReason,
  type MediaRoomRef,
} from "@vaskel/contracts/media";
import type { MediaClosureDisposition } from "@/server/media/disposition";

const endpointSchema = z.strictObject({
  room: MediaRoomRefSchema,
  clientId: z.string(),
  sessionId: z.string(),
  tokenHash: z.string(),
  permissionGeneration: z.number().int().nonnegative(),
});
const cleanupSchema = z.strictObject({
  room: MediaRoomRefSchema,
  generation: z.number().int().nonnegative(),
  reason: z.enum(["leave", "replace"]),
});

/** Every retained cleanup target belongs to this intent. Transfers retain none. */
export const ParticipationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("idle") }),
  z.strictObject({
    kind: z.literal("left"),
    previousTokenHash: z.string().nullable(),
    reason: MediaEndReasonSchema,
  }),
  z.strictObject({
    kind: z.literal("joining"),
    endpoint: endpointSchema,
    deadline: z.number(),
    predecessor: cleanupSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("active"), endpoint: endpointSchema }),
  z.strictObject({
    kind: z.literal("recovering"),
    endpoint: endpointSchema,
    cleanup: cleanupSchema,
  }),
  z.strictObject({ kind: z.literal("resumable"), endpoint: endpointSchema }),
  z.strictObject({
    kind: z.literal("ending"),
    endpoint: endpointSchema,
    reason: MediaEndReasonSchema,
    cleanup: cleanupSchema,
  }),
  z.strictObject({
    kind: z.literal("ended"),
    endpoint: endpointSchema,
    reason: MediaEndReasonSchema,
  }),
]);
export const AccountReceiptSchema = z.strictObject({
  commandId: z.string(),
  hash: z.string(),
  operation: z.enum(["join", "transfer", "resume", "leave"]),
  sessionId: z.string(),
});
export type Endpoint = z.infer<typeof endpointSchema>;
export type CleanupClaim = z.infer<typeof cleanupSchema>;
export type Participation = z.infer<typeof ParticipationSchema>;
export type AccountReceipt = z.infer<typeof AccountReceiptSchema>;
export interface AccountState {
  userId: string;
  generation: number;
  participation: Participation;
  receipt: AccountReceipt | null;
}
export type IntendedParticipation = Extract<
  Participation,
  { kind: "joining" | "active" | "recovering" | "resumable" }
>;
export function hasIntent(
  participation: Participation,
): participation is IntendedParticipation {
  switch (participation.kind) {
    case "idle":
    case "left":
    case "ending":
    case "ended":
      return false;
    default:
      return true;
  }
}
export function endpointOf(participation: Participation): Endpoint | null {
  switch (participation.kind) {
    case "idle":
    case "left":
      return null;
    default:
      return participation.endpoint;
  }
}
/** Leave retires handle authority but does not permit reuse of its endpoint token. */
export function previousTokenHash(participation: Participation): string | null {
  return participation.kind === "left"
    ? participation.previousTokenHash
    : (endpointOf(participation)?.tokenHash ?? null);
}
export function cleanupOf(participation: Participation): CleanupClaim | null {
  switch (participation.kind) {
    case "joining":
      return participation.predecessor;
    case "recovering":
    case "ending":
      return participation.cleanup;
    default:
      return null;
  }
}

export function accountStatus(
  state: AccountState,
): Extract<AccountMediaOutcome, { kind: "media_status" }> {
  const { participation } = state;
  const status = {
    kind: "media_status" as const,
    generation: state.generation,
  };
  switch (participation.kind) {
    case "idle":
    case "left":
    case "ended":
      return { ...status, admission: { kind: "available" } };
    case "ending":
      return { ...status, admission: { kind: "cleanup_pending" } };
    case "resumable":
      return {
        ...status,
        admission: { kind: "resumable", room: participation.endpoint.room },
      };
    default:
      return {
        ...status,
        admission: {
          kind: "transfer_required",
          room: participation.endpoint.room,
        },
      };
  }
}

/** Closing is an obligation, not proof that participation was deliberately ended. */
export function recoverParticipation(state: AccountState): Participation {
  const { participation, generation } = state;
  if (!hasIntent(participation)) return participation;
  return {
    kind: "recovering",
    endpoint: participation.endpoint,
    cleanup: cleanupOf(participation) ?? {
      room: participation.endpoint.room,
      generation,
      reason: "replace",
    },
  };
}

export function endParticipation(
  state: AccountState,
  event:
    | { kind: "leave"; sessionId: string }
    | { kind: "terminal"; reason: MediaEndReason },
): Participation {
  const { participation, generation } = state;
  const endpoint = endpointOf(participation);
  const previous = cleanupOf(participation);
  const terminalReason =
    participation.kind === "ending" ||
    participation.kind === "ended" ||
    participation.kind === "left"
      ? participation.reason
      : event.kind === "leave"
        ? "left"
        : event.reason;
  if (!endpoint)
    return {
      kind: "left",
      previousTokenHash: previousTokenHash(participation),
      reason: terminalReason,
    };
  const cleanup = previous ?? {
    room: endpoint.room,
    generation,
    reason: "replace" as const,
  };
  return {
    kind: "ending",
    endpoint:
      event.kind === "leave"
        ? { ...endpoint, sessionId: event.sessionId }
        : endpoint,
    reason: terminalReason,
    cleanup: event.kind === "leave" ? { ...cleanup, reason: "leave" } : cleanup,
  };
}

/** Called only after matching the durable cleanup target in the native transaction. */
export function settleCleanup(
  state: AccountState,
  closed: boolean,
  disposition: MediaClosureDisposition,
): Participation {
  let participation = state.participation;
  if (disposition.kind === "terminal")
    participation = endParticipation(state, {
      kind: "terminal",
      reason: disposition.reason,
    });
  if (!closed) return participation;
  switch (participation.kind) {
    case "joining":
      return { ...participation, predecessor: null };
    case "recovering":
      return { kind: "resumable", endpoint: participation.endpoint };
    case "ending":
      if (participation.cleanup.reason === "leave")
        return {
          kind: "left",
          previousTokenHash: participation.endpoint.tokenHash,
          reason: participation.reason,
        };
      return {
        kind: "ended",
        endpoint: participation.endpoint,
        reason: participation.reason,
      };
    default:
      throw new Error("Account cleanup has no retained obligation.");
  }
}

export function currentClaim(
  state: AccountState,
): { room: MediaRoomRef; generation: number } | null {
  const endpoint = endpointOf(state.participation);
  return endpoint
    ? { room: endpoint.room, generation: state.generation }
    : null;
}
