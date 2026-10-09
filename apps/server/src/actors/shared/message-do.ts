import type {
  CommittedNotificationOffer,
  NotificationMessageQuery,
  NotificationMessageReference,
} from "@/server/notifications/protocol";
import { selectNotificationMessage } from "./notification-source";
import { ACTOR_WORK_BUDGET_MS } from "./bounded-work";
import { logEvent } from "@/server/telemetry";
import { applyMediaOccupancy, type MediaOccupancyRequest } from "./occupancy";
import { DurableObject } from "cloudflare:workers";
import {
  type DeleteMessage,
  type MessagingOutcome,
  type ReactMessage,
  type AroundRequest,
  type EditMessage,
  type QuoteReference,
  type OriginalMessageRequest,
  type RemoveMessageAttachment,
  type PrepareSocket,
  type RenewSocket,
  type ReadRequest,
  type ReplayRequest,
  type SearchRequest,
  type SendMessage,
  type SnapshotRequest,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";
import type {
  AttachmentIncident,
  ReserveAttachment,
} from "@vaskel/contracts/attachments";
import {
  attachmentStatus,
  beginAttachmentUpload,
  cancelAttachment,
  completeAttachmentUpload,
  reserveAttachment,
  setAttachmentIncident,
} from "./attachments/commands";
import { authorizeAttachmentDownload } from "./attachments/download";
import type {
  AttachmentUpload,
  AttachmentUploadResult,
  StoredAttachment,
} from "./attachments/types";
import { maintainOwner } from "./maintenance";
import { directory } from "./directory";
import { members, sharedPeople } from "./members";
import { activity } from "./activity";
import { rebuildSearchIndex } from "./search-index";
import type { PresenceSelection } from "@vaskel/contracts/presence";
import { presenceCandidates } from "./presence-candidates";
import type { ActivityRequest } from "@vaskel/contracts/activity";
import { openOwnerDatabase } from "./database";
import { acknowledgeSocketClose } from "./websocket-close";
import {
  operatorOwnerUsage,
  ownerCapacity,
  ownerSqlBudgetBytes,
} from "./capacity";
import {
  mutateMessage,
  prepareSend,
  type MessageMutationOutcome,
} from "./messages";
import {
  notifyCommit,
  notifyRead,
  notifyDirectory,
  notifyChannelHint,
  notifyPresence,
} from "./event-notices";
import { captureQuoteInTransaction, type CapturedQuote } from "./quotes";
import { authorizeMedia } from "./media-authorization";
import {
  broadcastCommit,
  broadcastRead,
  prepareSocket,
  renewSocket,
  socketMessage,
  upgradeSocket,
} from "./sockets";
import {
  aroundMessages,
  replayMessages,
  searchMessages,
  snapshotMessages,
  updateReadCursor,
  originalMessage,
} from "./synchronization";

/** Thin entry point. All SQL and permission decisions stay inside this actor. */
export abstract class MessageDO extends DurableObject<Env> {
  protected readonly database;
  protected readonly sqlBudgetBytes;
  private readonly lastTyping = new WeakMap<WebSocket, number>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    this.sqlBudgetBytes = ownerSqlBudgetBytes(env.OWNER_SQL_BUDGET_BYTES);
    this.database = openOwnerDatabase(ctx.storage, ctx.id.toString());
  }
  operatorUsage(principal: Principal & { isOperator: true }) {
    return operatorOwnerUsage(
      this.ctx,
      this.database,
      principal,
      this.sqlBudgetBytes,
    );
  }
  rebuildSearchIndex(principal: Principal & { isOperator: true }) {
    return rebuildSearchIndex(this.ctx.storage, this.database, principal);
  }
  capacity(principal: Principal & { isOperator?: true }) {
    return ownerCapacity(
      this.ctx,
      this.database,
      principal,
      this.sqlBudgetBytes,
    );
  }
  reserveAttachment(principal: Principal, request: ReserveAttachment) {
    return reserveAttachment(
      this.ctx.storage,
      this.database,
      principal,
      request,
      this.sqlBudgetBytes,
    );
  }
  beginAttachmentUpload(principal: Principal, fileId: string) {
    return beginAttachmentUpload(
      this.ctx.storage,
      this.database,
      principal,
      fileId,
    );
  }
  completeAttachmentUpload(
    principal: Principal | null,
    upload: AttachmentUpload,
    result: AttachmentUploadResult,
  ) {
    return completeAttachmentUpload(
      this.ctx.storage,
      this.database,
      principal,
      upload,
      result,
    );
  }
  attachmentStatus(principal: Principal, fileId: string) {
    return attachmentStatus(this.ctx.storage, this.database, principal, fileId);
  }
  cancelAttachment(principal: Principal, fileId: string) {
    return cancelAttachment(this.ctx.storage, this.database, principal, fileId);
  }
  authorizeAttachmentDownload(
    principal: Principal,
    fileId: string,
    observed?: StoredAttachment,
  ) {
    return authorizeAttachmentDownload(
      this.ctx.storage,
      this.database,
      principal,
      fileId,
      observed,
    );
  }
  setAttachmentIncident(
    principal: Principal & { isOperator: true },
    fileId: string,
    request: AttachmentIncident,
  ) {
    return setAttachmentIncident(
      this.ctx.storage,
      this.database,
      principal,
      fileId,
      request,
    );
  }
  activity(principal: Principal, request: ActivityRequest) {
    return activity(this.ctx.storage, this.database, principal, request);
  }
  directory(
    principal: Principal,
    invitePolicy: import("@vaskel/contracts/instance").InvitePolicy = "owners",
  ) {
    return directory(this.ctx.storage, this.database, principal, invitePolicy);
  }
  presenceCandidates(principal: Principal, selection: PresenceSelection = {}) {
    return presenceCandidates(
      this.ctx.storage,
      this.database,
      principal,
      selection,
    );
  }
  emitPresenceHint(userId: string) {
    return notifyPresence(this.ctx, this.env, this.database, userId);
  }
  members(principal: Principal) {
    return members(this.ctx.storage, this.database, principal);
  }
  sharedPeople(principal: Principal, userIds: string[]) {
    return sharedPeople(this.ctx.storage, this.database, principal, userIds);
  }
  async applyMediaOccupancy(request: MediaOccupancyRequest) {
    const result = await applyMediaOccupancy(
      this.ctx.storage,
      this.database,
      request,
    );
    if (result.kind === "applied") {
      try {
        await notifyChannelHint(this.ctx, this.env, this.database, {
          type: result.occupancyChanged ? "occupancy" : "call",
          owner: request.room.owner,
          channelId: request.room.channelId,
        });
      } catch (error) {
        /* Directory reads and call heartbeats recover missed hints. */
        logEvent(
          "warn",
          "message_side_effect_failed",
          { actorId: this.ctx.id.toString(), operation: "occupancy_hint" },
          error,
        );
      }
    }
    return result;
  }
  authorizeMedia(principal: Principal, request: { channelId: string }) {
    return authorizeMedia(this.ctx.storage, this.database, principal, request);
  }
  async send(
    principal: Principal,
    command: SendMessage,
    capturedQuote?: CapturedQuote,
    senderLabel = "Someone",
  ): Promise<{
    outcome: MessagingOutcome;
    notification: CommittedNotificationOffer | null;
  }> {
    const result = await mutateMessage(
      this.ctx.storage,
      this.database,
      principal,
      { kind: "send", command, ...(capturedQuote ? { capturedQuote } : {}) },
      this.sqlBudgetBytes,
    );
    const deadline = Date.now() + ACTOR_WORK_BUDGET_MS;
    const { outcome, recipients } = await this.publish(result);
    const reference =
      result.kind === "committed" && result.notification
        ? { ...result.notification, senderLabel: senderLabel.slice(0, 200) }
        : null;
    return {
      outcome,
      notification:
        reference && recipients.length
          ? { recipients, reference, deadline }
          : null,
    };
  }
  /** Trusted notification binding only; current recipient policy stays in owner SQL. */
  selectNotificationMessage(
    accountId: string,
    references: NotificationMessageReference[],
    query: NotificationMessageQuery,
  ) {
    return selectNotificationMessage(
      this.ctx.storage,
      this.database,
      accountId,
      references,
      query,
    );
  }
  async react(principal: Principal, command: ReactMessage) {
    const result = await mutateMessage(
      this.ctx.storage,
      this.database,
      principal,
      { kind: "react", command },
      this.sqlBudgetBytes,
    );
    return (await this.publish(result)).outcome;
  }
  around(principal: Principal, request: AroundRequest) {
    return aroundMessages(this.ctx.storage, this.database, principal, request);
  }
  async edit(principal: Principal, command: EditMessage) {
    const result = await mutateMessage(
      this.ctx.storage,
      this.database,
      principal,
      { kind: "edit", command },
      this.sqlBudgetBytes,
    );
    return (await this.publish(result)).outcome;
  }
  async deleteMessage(principal: Principal, command: DeleteMessage) {
    const result = await mutateMessage(
      this.ctx.storage,
      this.database,
      principal,
      { kind: "delete", command },
      this.sqlBudgetBytes,
    );
    return (await this.publish(result)).outcome;
  }
  async removeMessageAttachment(
    principal: Principal,
    command: RemoveMessageAttachment,
  ) {
    const result = await mutateMessage(
      this.ctx.storage,
      this.database,
      principal,
      { kind: "remove_attachment", command },
      this.sqlBudgetBytes,
    );
    return (await this.publish(result)).outcome;
  }
  prepareSend(principal: Principal, command: SendMessage) {
    return prepareSend(
      this.ctx.storage,
      this.database,
      principal,
      command,
      this.sqlBudgetBytes,
    );
  }
  captureQuote(principal: Principal, selected: QuoteReference) {
    return this.ctx.storage.transaction(() =>
      captureQuoteInTransaction(this.database, principal, selected),
    );
  }
  originalMessage(principal: Principal, request: OriginalMessageRequest) {
    return originalMessage(this.ctx.storage, this.database, principal, request);
  }
  snapshot(principal: Principal, request: SnapshotRequest) {
    return snapshotMessages(
      this.ctx.storage,
      this.database,
      principal,
      request,
    );
  }
  replay(principal: Principal, request: ReplayRequest) {
    return replayMessages(this.ctx.storage, this.database, principal, request);
  }
  search(principal: Principal, request: SearchRequest) {
    return searchMessages(this.ctx.storage, this.database, principal, request);
  }
  async updateRead(principal: Principal, request: ReadRequest) {
    const result = await updateReadCursor(
      this.ctx.storage,
      this.database,
      principal,
      request,
    );
    if (result.kind === "read_updated") {
      try {
        await broadcastRead(
          this.ctx,
          this.database,
          principal,
          request.channelId,
          result.sequence,
        );
      } catch (error) {
        /* Private read state recovers through the next snapshot. */
        logEvent(
          "warn",
          "message_side_effect_failed",
          { actorId: this.ctx.id.toString(), operation: "read_broadcast" },
          error,
        );
      }
      try {
        await notifyRead(
          this.ctx,
          this.env,
          this.database,
          principal,
          request.channelId,
        );
      } catch (error) {
        /* The private HTTP cursor remains authoritative. */
        logEvent(
          "warn",
          "message_side_effect_failed",
          { actorId: this.ctx.id.toString(), operation: "read_hint" },
          error,
        );
      }
    }
    return result;
  }
  prepareSocket(principal: Principal, request: PrepareSocket) {
    return prepareSocket(this.ctx.storage, this.database, principal, request);
  }
  renewSocket(principal: Principal, request: RenewSocket) {
    return renewSocket(this.ctx, this.database, principal, request);
  }
  override fetch(request: Request) {
    return upgradeSocket(this.ctx, this.database, request);
  }
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return socketMessage(
      this.ctx,
      this.database,
      socket,
      message,
      this.lastTyping,
    );
  }
  override webSocketClose(socket: WebSocket, code: number) {
    acknowledgeSocketClose(socket, code);
  }
  override webSocketError(socket: WebSocket) {
    socket.close(1011, "Reconnect required");
  }
  override alarm() {
    return maintainOwner(this.ctx, this.env, this.database, () =>
      this.notifyDirectory(),
    );
  }
  /** Trusted Worker calls after directory publication/index repair has committed. */
  publishDirectoryHints() {
    return this.notifyDirectory();
  }
  protected async notifyDirectory(removedUserId?: string) {
    try {
      await notifyDirectory(this.ctx, this.env, this.database, removedUserId);
    } catch (error) {
      /* Directory reads repair missed hints. */
      logEvent(
        "warn",
        "message_side_effect_failed",
        { actorId: this.ctx.id.toString(), operation: "directory_hint" },
        error,
      );
    }
  }
  private async publish(
    result: MessageMutationOutcome,
  ): Promise<{ outcome: MessagingOutcome; recipients: string[] }> {
    if (result.kind !== "accepted" && result.kind !== "committed")
      return { outcome: result, recipients: [] };
    try {
      await broadcastCommit(this.ctx, this.database, result.receipt);
    } catch (error) {
      /* Commit is durable; a missed broadcast is recovered by replay. */
      logEvent(
        "warn",
        "message_side_effect_failed",
        { actorId: this.ctx.id.toString(), operation: "commit_broadcast" },
        error,
      );
    }
    let recipients: string[] = [];
    if (result.kind === "committed") {
      try {
        recipients = await notifyCommit(
          this.ctx,
          this.env,
          this.database,
          result.notice,
        );
      } catch (error) {
        /* Account-event hints do not change an accepted commit. */
        logEvent(
          "warn",
          "message_side_effect_failed",
          { actorId: this.ctx.id.toString(), operation: "commit_hint" },
          error,
        );
      }
    }
    return {
      outcome: { kind: "accepted", receipt: result.receipt },
      recipients,
    };
  }
}
