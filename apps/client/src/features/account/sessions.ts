import type { AccountSession } from "@vaskel/contracts/account";

/**
 * This device first, then the most recent sign-in. Equal or unreadable times
 * keep a stable order by id so a refresh never reshuffles the list.
 */
export function orderSessions(
  sessions: readonly AccountSession[],
): AccountSession[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(created) && created !== 0) return created;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
