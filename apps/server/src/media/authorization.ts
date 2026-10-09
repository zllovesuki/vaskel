import type {
  MediaRoomRef,
  MediaFailure,
  MediaSnapshot,
  MediaRecoveryReason,
} from "@vaskel/contracts/media";

/** An owner-produced lease passed only through trusted Worker/actor RPC. */
export interface MediaAuthorization {
  room: MediaRoomRef;
  userId: string;
  sessionId: string;
  permissionGeneration: number;
  expiresAt: number;
  canJoin: boolean;
  canSpeak: boolean;
  canCamera: boolean;
  canScreen: boolean;
  canModerate: boolean;
}
export interface AccountClaim {
  room: MediaRoomRef;
  userId: string;
  sessionId: string;
  clientId: string;
  tokenHash: string;
  generation: number;
  participantId: string;
}
export function mediaRoomKey(room: MediaRoomRef): string {
  return `${room.owner.kind}:${room.owner.id}:${room.channelId}`;
}

export type MediaAdmissionOutcome =
  | MediaFailure
  | { kind: "admission_recovery"; reason: MediaRecoveryReason }
  | {
      kind: "admitted";
      producerVersion: number;
      consumerVersion: number;
      snapshot: MediaSnapshot;
    };
