import { logEvent } from "@/server/telemetry";
import { notifyDmPolicy } from "@/server/actors/shared/event-notices";
import type { InitializeConversation } from "@vaskel/contracts/administration";
import { initializeConversation } from "./initialization";
import { MessageDO } from "@/server/actors/shared/message-do";
import { directConversationId } from "@/server/directory/identifiers";
import type { BlockOutcome, SetBlock } from "@vaskel/contracts/blocking";
import type { Principal } from "@/server/domain/principal";
import { directStatus, readBlock, setBlock, type DirectPair } from "./blocks";
import { broadcastDmPolicy } from "@/server/actors/shared/sockets";

/** Conversation content is accessible only to its exact participant set. */
export class ConversationDO extends MessageDO {
  initialize(command: InitializeConversation) {
    return initializeConversation(this.ctx.storage, this.database, command);
  }
  private async pair(
    principal: Principal,
    targetId: string,
  ): Promise<DirectPair | null> {
    if (principal.userId === targetId) return null;
    const conversationId = await directConversationId(
      principal.userId,
      targetId,
    );
    return { conversationId, participantIds: [principal.userId, targetId] };
  }
  async blockStatus(
    principal: Principal,
    targetId: string,
  ): Promise<BlockOutcome> {
    const pair = await this.pair(principal, targetId);
    return pair
      ? readBlock(this.ctx.storage, this.database, principal, pair)
      : { kind: "invalid_input" };
  }
  directStatus(principal: Principal) {
    return directStatus(this.ctx.storage, this.database, principal);
  }
  async setBlock(
    principal: Principal,
    targetId: string,
    command: SetBlock,
  ): Promise<BlockOutcome> {
    const pair = await this.pair(principal, targetId);
    if (!pair) return { kind: "invalid_input" };
    const result = await setBlock(
      this.ctx.storage,
      this.database,
      principal,
      pair,
      command,
    );
    if (result.kind === "block_updated") {
      try {
        await broadcastDmPolicy(this.ctx, this.database);
      } catch (error) {
        /* The committed block remains authoritative. */
        logEvent(
          "warn",
          "message_side_effect_failed",
          { actorId: this.ctx.id.toString(), operation: "dm_policy_broadcast" },
          error,
        );
      }
      try {
        await notifyDmPolicy(this.ctx, this.env, this.database);
      } catch (error) {
        /* Reconnect/focus resync repairs a missed hint. */
        logEvent(
          "warn",
          "message_side_effect_failed",
          { actorId: this.ctx.id.toString(), operation: "dm_policy_hint" },
          error,
        );
      }
    }
    return result;
  }
}
