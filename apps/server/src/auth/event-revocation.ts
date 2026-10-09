import { eventDispatchStub } from "@/server/event-dispatch/routing";
import type { AuthEnvironment } from "./environment";
import type { EventDispatchRevocation } from "@/server/actors/event-dispatch/store";

/** Identity has already committed. Lost delivery is bounded by the account-events lease. */
export async function revokeAccountEvents(
  env: AuthEnvironment,
  userId: string,
  revocation: EventDispatchRevocation,
) {
  try {
    await eventDispatchStub(env, userId).revoke(userId, revocation);
  } catch {
    /* Fresh tickets/upgrades still require a primary-backed session. */
  }
}
