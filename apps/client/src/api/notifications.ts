import {
  type NotificationCommand,
  type NotificationState,
} from "@vaskel/contracts/notifications";
import { api } from "./contract";
import { queryOptions } from "@tanstack/react-query";

import { privateKey } from "./client";

export const notificationsKey = (accountId: string) =>
  [...privateKey(accountId), "notifications"] as const;
export async function fetchNotificationState(
  accountId: string,
  signal?: AbortSignal,
): Promise<NotificationState> {
  const result = await api.notifications(undefined, {
    ...(signal ? { signal } : {}),
    context: { accountId },
  });
  return result.state;
}
export function notificationsOptions(accountId: string) {
  return queryOptions({
    queryKey: notificationsKey(accountId),
    queryFn: ({ signal }) => fetchNotificationState(accountId, signal),
    retry: false,
  });
}
export async function notificationCommand(
  accountId: string,
  command: NotificationCommand,
) {
  const result = await api.notificationCommand(
    { body: command },
    { context: { accountId } },
  );
  return result.state;
}
