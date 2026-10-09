import { NotificationPayloadSchema } from "@vaskel/contracts/notification-payload";
import { notificationReturnPath } from "../routes/notification-target";

interface NotificationDisplay {
  showNotification(title: string, options: NotificationOptions): Promise<void>;
}
interface Badge {
  setAppBadge?(): Promise<void>;
}
interface NotificationClients {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<
    readonly {
      url: string;
      focus(): Promise<unknown>;
    }[]
  >;
  openWindow(url: string): Promise<unknown>;
}

/** Even an empty or unrecognized push must produce a visible notification. */
export async function receiveNotification(
  data: { json(): unknown } | null,
  registration: NotificationDisplay,
  badge: Badge,
) {
  let value: unknown;
  try {
    value = data?.json();
  } catch {
    /* Fall through to the generic notice. */
  }
  const parsed = NotificationPayloadSchema.safeParse(value);
  const payload = parsed.success ? parsed.data : null;
  await registration.showNotification(payload?.title || "vaskel.", {
    body: payload?.body || "New activity on vaskel.",
    ...(payload ? { tag: payload.tag } : {}),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: payload
      ? {
          accountId: payload.accountId,
          owner: payload.owner,
          roomId: payload.roomId,
        }
      : null,
  });
  // A dot means activity, never an exact unread total. Unsupported badges are harmless.
  try {
    await badge.setAppBadge?.();
  } catch {
    /* Display is already complete. */
  }
}

export async function openNotification(
  data: unknown,
  origin: string,
  clients: NotificationClients,
) {
  const url = new URL(notificationReturnPath(data), origin).href;
  // Preserve an existing conversation/call in another tab; reuse this return path only.
  try {
    const windows = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const existing = windows.find((client) => client.url === url);
    if (existing) {
      await existing.focus();
      return;
    }
  } catch {
    /* An expired client must not prevent opening the destination. */
  }
  await clients.openWindow(url);
}
