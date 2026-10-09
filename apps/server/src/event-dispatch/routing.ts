import {
  EVENT_DISPATCH_PARTITIONS,
  EVENT_DISPATCH_RECIPIENT_LIMIT,
} from "./limits";

export function eventDispatchName(userId: string) {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index++)
    hash = Math.imul(hash ^ userId.charCodeAt(index), 16777619);
  return `event-dispatch:${(hash >>> 0) % EVENT_DISPATCH_PARTITIONS}`;
}
export function eventDispatchStub(
  env: Pick<Env, "EVENT_DISPATCH">,
  userId: string,
) {
  return env.EVENT_DISPATCH.getByName(eventDispatchName(userId));
}
export function groupEventDispatchRecipients(userIds: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const userId of new Set(userIds)) {
    const name = eventDispatchName(userId);
    const recipients = groups.get(name) ?? [];
    recipients.push(userId);
    groups.set(name, recipients);
  }
  return [...groups].flatMap(([name, recipients]) => {
    const batches: { name: string; recipients: string[] }[] = [];
    for (
      let index = 0;
      index < recipients.length;
      index += EVENT_DISPATCH_RECIPIENT_LIMIT
    )
      batches.push({
        name,
        recipients: recipients.slice(
          index,
          index + EVENT_DISPATCH_RECIPIENT_LIMIT,
        ),
      });
    return batches;
  });
}
