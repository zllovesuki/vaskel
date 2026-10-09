import type {
  JoinMediaRequest,
  LeaveMediaRequest,
  MediaHandle,
  MediaRoomRef,
  PendingMediaCommand,
} from "@vaskel/contracts/media";
import { sha256Hex } from "@/server/auth/crypto";

export function leaveCommandHash(request: LeaveMediaRequest) {
  return sha256Hex(JSON.stringify(request));
}

export function accountCommand(pending: PendingMediaCommand): {
  operation: PendingMediaCommand["path"];
  request: JoinMediaRequest;
  resumeHandle: MediaHandle | undefined;
} {
  if (pending.path !== "resume")
    return {
      operation: pending.path,
      request: pending.body,
      resumeHandle: undefined,
    };
  const { handle, nextDeviceToken, commandId, issuedAt } = pending.body;
  return {
    operation: "resume",
    request: {
      room: handle.room,
      clientId: handle.clientId,
      deviceToken: nextDeviceToken,
      commandId,
      issuedAt,
      expectedGeneration: handle.accountGeneration,
    },
    resumeHandle: handle,
  };
}

function roomValue(room: MediaRoomRef) {
  return {
    owner: { kind: room.owner.kind, id: room.owner.id },
    channelId: room.channelId,
  };
}

/** Begin and pending Leave must compare the same complete, ordered request. */
export function accountCommandHash(command: ReturnType<typeof accountCommand>) {
  const { request, resumeHandle } = command;
  const canonical = {
    room: roomValue(request.room),
    clientId: request.clientId,
    deviceToken: request.deviceToken,
    commandId: request.commandId,
    issuedAt: request.issuedAt,
    expectedGeneration: request.expectedGeneration,
  };
  return sha256Hex(
    JSON.stringify(
      resumeHandle
        ? {
            request: canonical,
            handle: {
              room: roomValue(resumeHandle.room),
              participantId: resumeHandle.participantId,
              accountGeneration: resumeHandle.accountGeneration,
              clientId: resumeHandle.clientId,
              deviceToken: resumeHandle.deviceToken,
            },
          }
        : canonical,
    ),
  );
}
