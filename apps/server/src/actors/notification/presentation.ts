import { parseMessage, type MessageNode } from "@vaskel/contracts/message-text";
import type {
  NotificationPayload,
  NotificationPreferences,
} from "@vaskel/contracts/notifications";
import type { NotificationEligibleMessage } from "@/server/notifications/protocol";

/** Project the shared grammar, so hidden text and link metadata never become OS previews. */
function notificationPreview(body: string): string {
  function text(node: MessageNode): string {
    if (node.type === "spoiler") return "•••";
    if (node.type === "text" || node.type === "inlineCode") return node.value;
    if (node.type === "code") return `${node.value} `;
    if (node.type === "break") return " ";
    const children = "children" in node ? node.children.map(text).join("") : "";
    return [
      "paragraph",
      "heading",
      "listItem",
      "tableRow",
      "tableCell",
    ].includes(node.type)
      ? `${children} `
      : children;
  }
  return Array.from(text(parseMessage(body)).replace(/\s+/gu, " ").trim())
    .slice(0, 240)
    .join("");
}

const copy = {
  en: {
    activity: "New activity",
    message: "You have a new message on vaskel.",
    test: "Notifications are ready on this browser.",
  },
  "zh-Hans": {
    activity: "新动态",
    message: "你在 vaskel. 上有新消息。",
    test: "此浏览器的通知已就绪。",
  },
  "zh-Hant": {
    activity: "新動態",
    message: "你在 vaskel. 上有新訊息。",
    test: "此瀏覽器的通知已就緒。",
  },
  ja: {
    activity: "新しいアクティビティ",
    message: "vaskel. に新しいメッセージがあります。",
    test: "このブラウザーで通知を受け取れます。",
  },
};
export function notificationPayload(
  accountId: string,
  preferences: NotificationPreferences,
  message: NotificationEligibleMessage | null = null,
): NotificationPayload {
  const text = copy[preferences.language];
  if (!message)
    return {
      accountId,
      title: "vaskel.",
      body: text.test,
      tag: `${accountId}:test`,
      owner: null,
      roomId: null,
      messageId: null,
    };
  const { reference } = message;
  return {
    accountId,
    title:
      preferences.preview === "generic"
        ? text.activity
        : [message.senderLabel, message.roomLabel]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 250),
    body:
      preferences.preview === "message"
        ? notificationPreview(message.text ?? "") || text.message
        : text.message,
    tag: `${accountId}:${reference.owner.id}:${reference.roomId}`,
    owner: reference.owner,
    roomId: reference.roomId,
    messageId: reference.messageId,
  };
}
