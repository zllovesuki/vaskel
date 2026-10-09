import type { AccountPreferences } from "@vaskel/contracts/preferences";

/** Profile refresh and explicit saves share one monotonic preference merge. */
export function mergePreferences(
  accepted: AccountPreferences,
  incoming: AccountPreferences,
): AccountPreferences {
  return incoming.revision > accepted.revision ? incoming : accepted;
}
