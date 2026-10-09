import { holdWebLock } from "@/client/browser/locks";

/** A saved draft has one live editor; another tab can start an independent draft. */
export async function claimDraft(
  accountId: string,
  id: string,
): Promise<(() => void) | null> {
  const locks = navigator.locks;
  if (!locks) throw new Error("Draft storage requires Web Locks.");
  const held = holdWebLock(locks, `vaskel:draft:${accountId}:${id}`, {
    ifAvailable: true,
  });
  return (await held.acquired) ? held.release : null;
}
