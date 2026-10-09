import { DurableObject } from "cloudflare:workers";
import {
  ACCOUNT_EVENTS_PING,
  ACCOUNT_EVENTS_PONG,
  type AccountEventHint,
} from "@vaskel/contracts/account-events";
import { EVENT_DISPATCH_RECIPIENT_LIMIT } from "@/server/event-dispatch/limits";
import { emitPresenceTransitions } from "@/server/event-dispatch/transitions";
import { alarmDispatch, scheduleAccountAlarm } from "./alarm";
import {
  prepareSocket,
  upgradeSocket,
  reconstructConnections,
  releaseConnection,
  accountSockets,
  attachment,
  close,
} from "./sockets";
import {
  openDispatchDatabase,
  accountSnapshots,
  type EventDispatchPrincipal,
  type EventDispatchRevocation,
} from "./store";
import {
  accountEligibility,
  recomputePresence,
  samplePresence,
} from "./presence";
import { revokeDispatchSession } from "./revocation";
import { acknowledgeSocketClose } from "@/server/actors/shared/websocket-close";

/** Partitioned ephemeral notification transport. Identity and message owners authorize it. */
export class EventDispatchDO extends DurableObject<Env> {
  private readonly database;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.database = openDispatchDatabase(ctx.storage, ctx.id.toString());
    reconstructConnections(ctx);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        ACCOUNT_EVENTS_PING,
        ACCOUNT_EVENTS_PONG,
      ),
    );
  }
  async prepareSocket(principal: EventDispatchPrincipal) {
    return prepareSocket(this.ctx, this.database, principal);
  }
  override async fetch(request: Request) {
    const response = await upgradeSocket(this.ctx, this.database, request);
    const userId = request.headers.get("X-Vaskel-User-Id");
    if (userId) await this.refreshPresence([userId]);
    return response;
  }
  async deliver(input: { recipients: string[]; notice: AccountEventHint }) {
    if (input.recipients.length > EVENT_DISPATCH_RECIPIENT_LIMIT)
      return { kind: "capacity" } as const;
    const frame = JSON.stringify(input.notice);
    await this.ctx.storage.transaction(async () => {
      const now = Date.now();
      const snapshots = await accountSnapshots(
        this.database,
        input.recipients,
        now,
      );
      for (const userId of new Set(input.recipients)) {
        const eligible = accountEligibility(
          this.ctx,
          userId,
          now,
          snapshots.get(userId)!,
        );
        for (const socket of accountSockets(this.ctx, userId)) {
          if (!eligible(socket)) continue;
          try {
            socket.send(frame);
          } catch {
            close(this.ctx, socket, "lease_expired");
          }
        }
      }
    });
    return { kind: "delivered" } as const;
  }
  async samplePresence(userIds: string[]) {
    if (userIds.length > EVENT_DISPATCH_RECIPIENT_LIMIT)
      return { kind: "capacity" } as const;
    return this.ctx.storage.transaction(async () => ({
      kind: "presence_samples" as const,
      samples: await samplePresence(this.ctx, this.database, userIds),
    }));
  }
  async revoke(userId: string, revocation: EventDispatchRevocation) {
    await revokeDispatchSession(this.ctx, this.database, userId, revocation);
    await this.refreshPresence([userId]);
    return { kind: "revoked" } as const;
  }
  override async webSocketMessage(socket: WebSocket) {
    try {
      socket.close(1008, "Unsupported frame");
    } finally {
      await this.refreshSocket(socket);
    }
  }
  override async webSocketClose(socket: WebSocket, code: number) {
    try {
      acknowledgeSocketClose(socket, code);
    } finally {
      await this.refreshSocket(socket);
    }
  }
  override async webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, "Reconnect required");
    } finally {
      await this.refreshSocket(socket);
    }
  }
  private async refreshSocket(socket: WebSocket) {
    releaseConnection(this.ctx, socket);
    const value = attachment(socket);
    if (value) await this.refreshPresence([value.userId]);
  }
  private async refreshPresence(userIds: string[]) {
    const changed = await this.ctx.storage.transaction(async () => {
      const changed = await recomputePresence(this.ctx, this.database, userIds);
      await scheduleAccountAlarm(this.ctx, userIds);
      return changed;
    });
    emitPresenceTransitions(this.ctx, this.env, changed);
  }
  override async alarm() {
    emitPresenceTransitions(
      this.ctx,
      this.env,
      await alarmDispatch(this.ctx, this.database),
    );
  }
}
