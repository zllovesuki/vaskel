import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { NotificationState } from "@vaskel/contracts/notifications";

/** A room's explicit choice; absent means the default, Direct only without a mute. */
export function roomPreference(
  state: NotificationState | undefined,
  owner: OwnerScope,
  roomId: string,
) {
  return state?.rooms.find(
    (room) =>
      room.owner.kind === owner.kind &&
      room.owner.id === owner.id &&
      room.roomId === roomId,
  );
}
