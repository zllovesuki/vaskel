import schema from "./migrations/0001_sessions.sql?raw";
import type { Kysely } from "kysely";
import type { Principal } from "@/server/domain/principal";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";

export interface EventDispatchPrincipal extends Principal {
  sessionExpiresAt: number;
  authEpoch: number;
}
export type EventDispatchRevocation =
  | { kind: "session"; sessionId: string; expiresAt: number }
  | { kind: "epoch"; minimumAuthEpoch: number; preserveSessionId?: string };
export interface EventDispatchDatabase {
  dispatch_accounts: {
    user_id: string;
    minimum_auth_epoch: number;
    online: number;
  };
  dispatch_tickets: {
    ticket_hash: string;
    user_id: string;
    session_id: string;
    auth_epoch: number;
    expires_at: number;
    lease_expires_at: number;
  };
  dispatch_revoked_sessions: {
    user_id: string;
    session_id: string;
    expires_at: number;
  };
}
export function openDispatchDatabase(
  storage: DurableObjectStorage,
  actorId?: string,
) {
  migrateActorStorage(
    storage,
    [{ version: 1, name: "event-dispatch-sessions", sql: schema }],
    { schema: "event_dispatch", actorId },
  );
  return createActorDatabase<EventDispatchDatabase>(storage);
}
/** Caller holds the native transaction; the mapping cannot be selected by ingress. */
export async function bindAccount(
  db: Kysely<EventDispatchDatabase>,
  userId: string,
) {
  await db
    .insertInto("dispatch_accounts")
    .values({
      user_id: userId,
      minimum_auth_epoch: 0,
      online: 0,
    })
    .onConflict((c) => c.column("user_id").doNothing())
    .execute();
}
export async function sessionRevoked(
  db: Kysely<EventDispatchDatabase>,
  userId: string,
  sessionId: string,
  authEpoch: number,
) {
  const account = await db
    .selectFrom("dispatch_accounts")
    .select("minimum_auth_epoch")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (authEpoch < (account?.minimum_auth_epoch ?? 0)) return true;
  return Boolean(
    await db
      .selectFrom("dispatch_revoked_sessions")
      .select("session_id")
      .where("user_id", "=", userId)
      .where("session_id", "=", sessionId)
      .where("expires_at", ">", Date.now())
      .executeTakeFirst(),
  );
}

export interface AccountSnapshot {
  account?: EventDispatchDatabase["dispatch_accounts"];
  revoked: Set<string>;
}
/** One bounded SQL chunk stays below workerd's parameter limit, including expiry. */
export async function accountSnapshots(
  db: Kysely<EventDispatchDatabase>,
  userIds: readonly string[],
  now: number,
) {
  const ids = [...new Set(userIds)];
  const snapshots = new Map<string, AccountSnapshot>(
    ids.map((id) => [id, { revoked: new Set<string>() }]),
  );
  for (let index = 0; index < ids.length; index += 64) {
    const chunk = ids.slice(index, index + 64);
    for (const account of await db
      .selectFrom("dispatch_accounts")
      .selectAll()
      .where("user_id", "in", chunk)
      .execute())
      snapshots.get(account.user_id)!.account = account;
    for (const revoked of await db
      .selectFrom("dispatch_revoked_sessions")
      .select(["user_id", "session_id"])
      .where("user_id", "in", chunk)
      .where("expires_at", ">", now)
      .execute())
      snapshots.get(revoked.user_id)!.revoked.add(revoked.session_id);
  }
  return snapshots;
}
