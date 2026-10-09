import { createHttpApp } from "./http";
import { cleanupInstanceIcons } from "./instance/icons";
import { retryIdentityMail } from "./auth/mail";
import { logEvent } from "./telemetry";
import { consumePushBatch } from "./notifications/transport";

export { ServerDO } from "./actors/server/server-do";
export { ConversationDO } from "./actors/conversation/conversation-do";
export { MediaRoomDO } from "./actors/media/media-room-do";
export { EventDispatchDO } from "./actors/event-dispatch/event-dispatch-do";
export { AccountMediaDO } from "./actors/account-media/account-media-do";
export { NotificationDO } from "./actors/notification/notification-do";

const app = createHttpApp();

export default {
  fetch: app.fetch,
  queue: consumePushBatch,
  async scheduled(_controller, env) {
    await Promise.all([
      retryIdentityMail(env, { limit: 10 }).catch((error) => {
        logEvent("error", "identity_mail_retry_failed", {}, error);
        throw error;
      }),
      cleanupInstanceIcons(env),
    ]);
  },
} satisfies ExportedHandler<Env>;
