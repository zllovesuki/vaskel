import worker from "@/server/index";

// Native actor tests inspect queued work. Transport tests invoke the production
// consumer with a local provider fixture; ambient alarms never contact providers.
export default {
  ...worker,
  async queue(batch: MessageBatch<unknown>) {
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
export { DatabaseProbeDO } from "@tests/fixtures/database-probe";
export {
  ServerDO,
  ConversationDO,
  MediaRoomDO,
  AccountMediaDO,
  EventDispatchDO,
  NotificationDO,
} from "@/server/index";
