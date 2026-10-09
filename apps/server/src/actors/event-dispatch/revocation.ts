import type { Kysely } from "kysely";
import {
  bindAccount,
  sessionRevoked,
  type EventDispatchDatabase,
  type EventDispatchRevocation,
} from "./store";
import { accountSockets, attachment, close } from "./sockets";
import { scheduleAlarm } from "@/server/actors/shared/alarms";

/** Fences cover assertions and tickets issued before the identity mutation. */
export async function revokeDispatchSession(
  ctx: DurableObjectState,
  db: Kysely<EventDispatchDatabase>,
  userId: string,
  revocation: EventDispatchRevocation,
) {
  await ctx.storage.transaction(async () => {
    await bindAccount(db, userId);
    if (revocation.kind === "session") {
      await db
        .insertInto("dispatch_revoked_sessions")
        .values({
          user_id: userId,
          session_id: revocation.sessionId,
          expires_at: revocation.expiresAt,
        })
        .onConflict((c) =>
          c
            .columns(["user_id", "session_id"])
            .doUpdateSet({ expires_at: revocation.expiresAt })
            .where(
              "dispatch_revoked_sessions.expires_at",
              "<",
              revocation.expiresAt,
            ),
        )
        .execute();
      await db
        .deleteFrom("dispatch_tickets")
        .where("user_id", "=", userId)
        .where("session_id", "=", revocation.sessionId)
        .execute();
      await scheduleAlarm(ctx.storage, revocation.expiresAt);
    } else {
      await db
        .updateTable("dispatch_accounts")
        .set({ minimum_auth_epoch: revocation.minimumAuthEpoch })
        .where("user_id", "=", userId)
        .where("minimum_auth_epoch", "<", revocation.minimumAuthEpoch)
        .execute();
      await db
        .deleteFrom("dispatch_tickets")
        .where("user_id", "=", userId)
        .where("auth_epoch", "<", revocation.minimumAuthEpoch)
        .execute();
    }
    // A retained session may adopt this epoch only while no newer epoch or
    // exact-session fence has superseded the grant. Old tickets remain deleted.
    const preserveAllowed =
      revocation.kind === "epoch" &&
      revocation.preserveSessionId !== undefined &&
      !(await sessionRevoked(
        db,
        userId,
        revocation.preserveSessionId,
        revocation.minimumAuthEpoch,
      ));
    for (const socket of accountSockets(ctx, userId)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const value = attachment(socket);
      if (
        value &&
        preserveAllowed &&
        revocation.kind === "epoch" &&
        value.sessionId === revocation.preserveSessionId &&
        value.authEpoch < revocation.minimumAuthEpoch &&
        value.leaseExpiresAt > Date.now()
      ) {
        socket.serializeAttachment({
          ...value,
          authEpoch: revocation.minimumAuthEpoch,
        });
        continue;
      }
      if (
        !value ||
        (revocation.kind === "session"
          ? value.sessionId === revocation.sessionId
          : value.authEpoch < revocation.minimumAuthEpoch)
      )
        close(ctx, socket, "revoked");
    }
  });
}
