import type {
  NotificationMessageQuery,
  NotificationMessageReference,
} from "@/server/notifications/protocol";
import { NOTIFICATION_GROUP_LIMIT } from "@vaskel/contracts/notifications";
import { ownerStub } from "@/server/directory/owners";

/** Account groups belong to one owner/room; routing requires no identity-directory lookup. */
export async function selectNotificationMessage(
  env: Env,
  accountId: string,
  references: NotificationMessageReference[],
  query: NotificationMessageQuery,
) {
  const first = references[0];
  if (
    !first ||
    references.length > NOTIFICATION_GROUP_LIMIT ||
    references.some(
      (reference) =>
        reference.owner.kind !== first.owner.kind ||
        reference.owner.id !== first.owner.id ||
        reference.roomId !== first.roomId,
    )
  )
    return null;
  return ownerStub(env, first.owner).selectNotificationMessage(
    accountId,
    references,
    query,
  );
}
