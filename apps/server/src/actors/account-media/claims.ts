import { type MediaHandle, type MediaFailure } from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import { mediaRoomKey } from "@/server/media/authorization";
import { sha256Hex } from "@/server/auth/crypto";
import { endpointOf, type AccountState } from "./state";
import { accountCommand } from "@/server/actors/account-media/commands";

export function endedParticipation(
  state: AccountState,
): Extract<MediaFailure, { kind: "participation_ended" }> {
  const participation = state.participation;
  if (participation.kind !== "ending" && participation.kind !== "ended")
    throw new Error("Account participation has not ended.");
  return {
    kind: "participation_ended",
    generation: state.generation,
    reason: participation.reason,
  };
}

export async function validateHandle(
  state: AccountState,
  principal: Principal,
  handle: MediaHandle,
): Promise<MediaFailure | null> {
  if (state.generation !== handle.accountGeneration)
    return { kind: "stale_generation", currentGeneration: state.generation };
  const endpoint = endpointOf(state.participation);
  if (
    !endpoint ||
    state.userId !== principal.userId ||
    endpoint.sessionId !== principal.sessionId ||
    endpoint.clientId !== handle.clientId ||
    endpoint.tokenHash !== (await sha256Hex(handle.deviceToken)) ||
    state.userId !== handle.participantId ||
    mediaRoomKey(endpoint.room) !== mediaRoomKey(handle.room)
  )
    return { kind: "forbidden" };
  return null;
}

export async function validatePendingLeave(
  state: AccountState,
  principal: Principal,
  command: ReturnType<typeof accountCommand>,
  hash: string,
): Promise<MediaFailure | null> {
  const { request, operation, resumeHandle } = command;
  if (
    state.receipt?.commandId === request.commandId &&
    state.receipt.operation === operation
  ) {
    if (state.receipt.hash !== hash) return { kind: "command_conflict" };
    if (state.receipt.sessionId !== principal.sessionId)
      return { kind: "forbidden" };
    return null;
  }
  if (state.generation !== request.expectedGeneration)
    return { kind: "stale_generation", currentGeneration: state.generation };
  if (resumeHandle) return validateHandle(state, principal, resumeHandle);
  if (operation === "join") return admissionFailure(state, operation);
  // A confirmed Move followed by Leave ends the predecessor too. Its original
  // CAS prevents a delayed cancellation from touching a newer explicit claim.
  return null;
}

/** New claims and pending-Join cancellation share the same admission decision. */
export function admissionFailure(
  state: AccountState,
  operation: "join" | "transfer" | "resume",
): MediaFailure | null {
  const { participation, generation } = state;
  switch (participation.kind) {
    case "ending":
      return { kind: "cleanup_pending", generation };
    case "joining":
    case "recovering":
      return operation === "transfer"
        ? null
        : { kind: "cleanup_pending", generation };
    case "active":
      return operation === "join"
        ? {
            kind: "transfer_required",
            currentGeneration: generation,
            room: participation.endpoint.room,
          }
        : null;
    case "idle":
    case "left":
    case "ended":
    case "resumable":
      return null;
  }
}
