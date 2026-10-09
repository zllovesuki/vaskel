import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UiLanguage } from "@vaskel/contracts/preferences";
import type {
  NotificationCommand,
  NotificationState,
} from "@vaskel/contracts/notifications";
import { isNetworkError } from "@/client/api/errors";
import {
  notificationsKey,
  notificationsOptions,
  notificationCommand,
} from "@/client/api/notifications";
import { useAccess } from "@/client/features/cache/access/context";
import { useUser } from "@/client/features/auth/session-state";
import {
  enableNotifications,
  releaseOrphanedSubscription,
  removeNotifications,
  type EnrollmentGuard,
} from "./browser";

type SettingsCommand = Exclude<
  NotificationCommand,
  { kind: "enable" | "remove" }
>;
type CommandFields<T> = T extends unknown
  ? Omit<T, "commandId" | "issuedAt" | "expectedRevision">
  : never;
export type NotificationChange = CommandFields<SettingsCommand>;
/** Action origin stays attached to its progress, outcome and exact retry. */
export type NotificationOperation =
  | { kind: "command"; command: SettingsCommand }
  | { kind: "enable" }
  | { kind: "remove-this-device" | "remove-device"; deviceId: string }
  | { kind: "release" };
type NotificationAction =
  | Exclude<NotificationOperation, { kind: "enable" }>
  | { kind: "enable"; result: Promise<NotificationState> };
type NotificationVariables = {
  guard: EnrollmentGuard;
  action: NotificationAction;
};
export type Notifications = ReturnType<typeof useNotifications>;
const abort = () => new DOMException("Account changed", "AbortError");

export function useNotifications() {
  const user = useUser();
  const access = useAccess();
  const client = useQueryClient();
  const query = useQuery({
    ...notificationsOptions(user.userId),
    enabled: access.canUseNetwork,
  });
  function capture(): EnrollmentGuard {
    const token = access.accountToken();
    return {
      accountId: user.userId,
      current: () => access.accountCurrent(token),
    };
  }
  const mutation = useMutation({
    mutationKey: [...notificationsKey(user.userId), "change"],
    networkMode: "always",
    retry: false,
    mutationFn: async ({ guard, action }: NotificationVariables) => {
      if (!guard.current()) throw abort();
      let state: NotificationState | void;
      switch (action.kind) {
        case "command":
          state = await notificationCommand(guard.accountId, action.command);
          break;
        case "enable":
          state = await action.result;
          break;
        case "remove-this-device":
        case "remove-device":
          state = await removeNotifications(guard, action.deviceId);
          break;
        case "release":
          state = await releaseOrphanedSubscription(guard);
          break;
      }
      if (!guard.current()) throw abort();
      if (state) client.setQueryData(notificationsKey(user.userId), state);
      return state;
    },
    onSettled: () => {
      // Also refreshes this browser's subscription reading, keyed beneath the same prefix.
      void client.invalidateQueries({
        queryKey: notificationsKey(user.userId),
      });
    },
  });
  function run(action: NotificationAction, onSettled?: () => void) {
    mutation.mutate(
      { guard: capture(), action },
      onSettled ? { onSettled } : undefined,
    );
  }
  function enable(label: string, language: UiLanguage) {
    const guard = capture();
    // Permission must start in the click, before Query schedules the mutation.
    const result = enableNotifications(guard, label, language);
    // Account retirement can prevent the mutation from observing this promise.
    void result.catch(() => {});
    mutation.mutate({ guard, action: { kind: "enable", result } });
  }
  function change(fields: NotificationChange) {
    if (!query.data || mutation.isPending) return;
    run({
      kind: "command",
      command: {
        ...fields,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedRevision: query.data.revision,
      },
    });
  }
  // Enable retries start at its button, preserving browser user activation.
  const retryable =
    isNetworkError(mutation.error) &&
    mutation.variables?.action.kind !== "enable";
  function retry() {
    const variables = mutation.variables;
    if (!retryable || !variables || mutation.isPending) return;
    if (variables.action.kind === "command") run(variables.action);
    else mutation.mutate(variables);
  }
  const operation: NotificationOperation | undefined =
    mutation.variables?.action;
  return {
    query,
    mutation: {
      isPending: mutation.isPending,
      isSuccess: mutation.isSuccess,
      error: mutation.error,
    },
    operation,
    enable,
    removeThisDevice: (deviceId: string) =>
      run({ kind: "remove-this-device", deviceId }),
    removeDevice: (deviceId: string, options?: { onSettled(): void }) =>
      run({ kind: "remove-device", deviceId }, options?.onSettled),
    releaseOrphan: () => run({ kind: "release" }),
    change,
    disabled: !access.canUseNetwork || mutation.isPending || !query.data,
    retryable,
    retry,
  };
}
