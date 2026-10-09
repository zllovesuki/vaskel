import type { CommittedNotificationOffer } from "./protocol";
import { BoundedWork } from "@/server/actors/shared/bounded-work";
import { logEvent } from "@/server/telemetry";

/** Each Worker request owns its RPCs; no pending I/O is shared between requests. */
export async function offerCommittedNotification(
  env: Env,
  { recipients, reference, deadline }: CommittedNotificationOffer,
) {
  const results = await new BoundedWork(8).map(
    recipients,
    (accountId) =>
      env.NOTIFICATION_DO.getByName(accountId).offerCommittedMessage(reference),
    deadline,
  );
  const failed = results.filter((result) => !result.ok).length;
  if (failed)
    logEvent("warn", "notification_offer_failed", {
      ownerId: reference.owner.id,
      processed: results.length,
      failed,
    });
}
