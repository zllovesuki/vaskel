/** Call in the obligation's native transaction; enqueue can only advance the alarm. */
export async function scheduleAlarm(
  storage: DurableObjectStorage,
  when: number,
) {
  const due = Math.max(Date.now() + 1, when);
  const existing = await storage.getAlarm();
  if (existing === null || existing > due) await storage.setAlarm(due);
}

/**
 * Replace from a complete, fresh domain snapshot in the caller's native transaction.
 * Callers classify expired validity, retries and backlog before choosing this time.
 */
export async function replaceAlarm(
  storage: DurableObjectStorage,
  when: number | null,
) {
  if (when === null) await storage.deleteAlarm();
  else await storage.setAlarm(Math.max(Date.now() + 1, when));
}

/** Physical socket cleanup is coarse; admission and delivery keep exact deadlines. */
export function socketCleanupWake(expiresAt: number, now = Date.now()) {
  return Math.ceil(Math.max(now + 1, expiresAt) / 30_000) * 30_000;
}
