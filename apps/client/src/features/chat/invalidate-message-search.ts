import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { MessagingOutcome } from "@vaskel/contracts/messaging";

/** Cancel even the first page: invalidation alone reuses a no-data request. */
export function invalidateMessageSearch(
  client: QueryClient,
  key: QueryKey,
  changed: ReadonlySet<string>,
  reset: boolean,
) {
  void client.cancelQueries({ queryKey: key }, { revert: false });
  client.setQueriesData<Extract<MessagingOutcome, { kind: "matches" }>>(
    { queryKey: key },
    (current) =>
      current
        ? {
            ...current,
            messages: reset
              ? []
              : current.messages.filter((message) => !changed.has(message.id)),
          }
        : current,
  );
  void client.invalidateQueries({ queryKey: key });
}
