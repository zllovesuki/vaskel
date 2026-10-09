import {
  AUTHORIZATION_RETENTION_MS,
  retentionWake,
} from "@/server/actors/shared/retention";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import type { Kysely } from "kysely";
import { OWNER_MEMBER_LIMIT } from "@vaskel/contracts/resources";
import type { z } from "zod";
import type {
  AuthorizeRegistrationSchema,
  CreateInviteSchema,
  InviteTokenSchema,
  RevokeInviteSchema,
  AdministrationOutcome,
  InvitesOutcomeSchema,
} from "@vaskel/contracts/administration";
import type { InvitePrincipal, Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { growthCapacityFailure } from "@/server/actors/shared/capacity";
import { queueDirectorySync } from "@/server/actors/shared/directory-sync";
import {
  access,
  getState,
  membership,
  ownerAccess,
  principalFailure,
  secret,
} from "@/server/actors/shared/policy";
import { sha256Hex } from "@/server/auth/crypto";

const REGISTRATION_RESERVATION_MS = 10 * 60 * 1_000;
async function validInvite(
  database: Kysely<OwnerDatabase>,
  tokenHash: string,
  token: string,
) {
  const state = await getState(database);
  if (
    !state ||
    state.owner_kind !== "server" ||
    token.split(".")[0] !== state.owner_id
  )
    return undefined;
  const invite = await database
    .selectFrom("invites")
    .selectAll()
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();
  return invite && invite.revoked === 0 && invite.expires_at > Date.now()
    ? invite
    : undefined;
}
async function reservations(
  database: Kysely<OwnerDatabase>,
  tokenHash: string,
  excludeUserId?: string,
) {
  let query = database
    .selectFrom("registration_authorizations")
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .where("token_hash", "=", tokenHash)
    .where("expires_at", ">", Date.now())
    .where("redeemed", "=", 0);
  if (excludeUserId !== undefined)
    query = query.where("user_id", "!=", excludeUserId);
  return (await query.executeTakeFirstOrThrow()).count;
}
export async function createInvite(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: InvitePrincipal,
  input: z.input<typeof CreateInviteSchema>,
  budgetBytes: number,
): Promise<AdministrationOutcome> {
  const command = { ...input, maxUses: input.maxUses ?? 1 };
  const random = secret();
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    if (
      authorized.member.role !== "owner" &&
      (principal.invitePolicy !== "members" ||
        authorized.state.members_may_invite === 0)
    )
      return { kind: "forbidden" };
    const now = Date.now();
    if (
      command.expiresAt <= now ||
      command.expiresAt > now + 30 * 24 * 60 * 60 * 1_000
    )
      return { kind: "invalid_input" };
    const count = await database
      .selectFrom("invites")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("revoked", "=", 0)
      .where("expires_at", ">", now)
      .whereRef("uses", "<", "max_uses")
      .executeTakeFirstOrThrow();
    if (count.count >= 100) return { kind: "capacity" };
    const { state } = authorized;
    const token = `${state.owner_id}.${random}`;
    const tokenHash = await sha256Hex(token);
    // Hash computation yields; access is rechecked immediately before the mutation.
    const changed = await access(database, principal);
    if (changed.kind !== "authorized") return changed;
    if (
      changed.member.role !== "owner" &&
      (principal.invitePolicy !== "members" ||
        changed.state.members_may_invite === 0)
    )
      return { kind: "forbidden" };
    const full = await growthCapacityFailure(storage, database, budgetBytes);
    if (full) return full;
    await database
      .insertInto("invites")
      .values({
        token_hash: tokenHash,
        creator_id: principal.userId,
        expires_at: command.expiresAt,
        max_uses: command.maxUses,
        uses: 0,
        revoked: 0,
        created_at: now,
      })
      .execute();
    return {
      kind: "invite_created",
      token,
      expiresAt: command.expiresAt,
      maxUses: command.maxUses,
    };
  });
}
export async function inspectInvite(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  input: z.infer<typeof InviteTokenSchema>,
  principal?: Principal,
): Promise<AdministrationOutcome> {
  const tokenHash = await sha256Hex(input.token);
  return storage.transaction(async () => {
    if (principal) {
      const failure = principalFailure(principal);
      if (failure) return failure;
    }
    const invite = await validInvite(database, tokenHash, input.token);
    if (
      !invite ||
      invite.uses +
        (await reservations(database, tokenHash, principal?.userId)) >=
        invite.max_uses
    )
      return { kind: "not_found" };
    const state = await getState(database);
    if (!state) return { kind: "not_found" };
    return {
      kind: "invite_valid",
      serverId: state.owner_id,
      name: state.name,
      expiresAt: invite.expires_at,
    };
  });
}
export async function authorizeRegistration(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  input: z.infer<typeof AuthorizeRegistrationSchema>,
  budgetBytes: number,
): Promise<AdministrationOutcome> {
  const command = input;
  const tokenHash = await sha256Hex(command.token);
  return storage.transaction(async () => {
    const now = Date.now();
    const previous = await database
      .selectFrom("registration_authorizations")
      .selectAll()
      .where("id", "=", command.registrationId)
      .executeTakeFirst();
    if (previous) {
      if (
        previous.token_hash !== tokenHash ||
        previous.user_id !== command.userId
      )
        return { kind: "command_conflict" };
      if (
        previous.expires_at <= now ||
        !(await validInvite(database, tokenHash, command.token))
      )
        return { kind: "command_expired" };
      return {
        kind: "registration_authorized",
        authorizationId: previous.id,
        expiresAt: previous.expires_at,
      };
    }
    const invite = await validInvite(database, tokenHash, command.token);
    if (
      !invite ||
      invite.uses + (await reservations(database, tokenHash)) >= invite.max_uses
    )
      return { kind: "not_found" };
    const total = await database
      .selectFrom("registration_authorizations")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("expires_at", ">", now)
      .where("redeemed", "=", 0)
      .executeTakeFirstOrThrow();
    if (total.count >= 100) return { kind: "capacity" };
    const full = await growthCapacityFailure(storage, database, budgetBytes);
    if (full) return full;
    const expiresAt = Math.min(
      invite.expires_at,
      now + REGISTRATION_RESERVATION_MS,
    );
    await database
      .insertInto("registration_authorizations")
      .values({
        id: command.registrationId,
        token_hash: tokenHash,
        user_id: command.userId,
        expires_at: expiresAt,
        redeemed: 0,
        created_at: now,
      })
      .execute();
    await scheduleAlarm(
      storage,
      retentionWake(now, AUTHORIZATION_RETENTION_MS),
    );
    return {
      kind: "registration_authorized",
      authorizationId: command.registrationId,
      expiresAt,
    };
  });
}
export async function redeemInvite(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: z.infer<typeof InviteTokenSchema>,
  budgetBytes: number,
): Promise<AdministrationOutcome> {
  const tokenHash = await sha256Hex(input.token);
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    const state = await getState(database);
    if (
      !state ||
      state.owner_kind !== "server" ||
      input.token.split(".")[0] !== state.owner_id
    )
      return { kind: "not_found" };
    const joined = await database
      .selectFrom("invite_joins")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .where("user_id", "=", principal.userId)
      .executeTakeFirst();
    if (joined)
      return (await membership(database, principal.userId))
        ? { kind: "joined", serverId: state.owner_id, version: state.version }
        : { kind: "forbidden" };
    const invite = await validInvite(database, tokenHash, input.token);
    if (!invite) return { kind: "not_found" };
    if (await membership(database, principal.userId))
      return {
        kind: "joined",
        serverId: state.owner_id,
        version: state.version,
      };
    if (
      invite.uses +
        (await reservations(database, tokenHash, principal.userId)) >=
      invite.max_uses
    )
      return { kind: "not_found" };
    const members = await database
      .selectFrom("members")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    if (members.count >= OWNER_MEMBER_LIMIT) return { kind: "capacity" };
    const full = await growthCapacityFailure(storage, database, budgetBytes);
    if (full) return full;
    await database
      .insertInto("members")
      .values({ user_id: principal.userId, role: "member" })
      .execute();
    await database
      .insertInto("invite_joins")
      .values({ token_hash: tokenHash, user_id: principal.userId })
      .execute();
    await database
      .updateTable("invites")
      .set({ uses: invite.uses + 1 })
      .where("token_hash", "=", tokenHash)
      .execute();
    await database
      .updateTable("registration_authorizations")
      .set({ redeemed: 1 })
      .where("token_hash", "=", tokenHash)
      .where("user_id", "=", principal.userId)
      .execute();
    await database
      .updateTable("owner_state")
      .set({ version: state.version + 1 })
      .where("id", "=", 1)
      .execute();
    await queueDirectorySync(storage);
    return {
      kind: "joined",
      serverId: state.owner_id,
      version: state.version + 1,
    };
  });
}
export async function revokeInvite(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: z.infer<typeof RevokeInviteSchema>,
): Promise<AdministrationOutcome> {
  const tokenHash =
    "tokenHash" in input ? input.tokenHash : await sha256Hex(input.token);
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const invite = await database
      .selectFrom("invites")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!invite) return { kind: "not_found" };
    if (
      invite.creator_id !== principal.userId &&
      authorized.member.role !== "owner"
    )
      return { kind: "forbidden" };
    await database
      .updateTable("invites")
      .set({ revoked: 1 })
      .where("token_hash", "=", tokenHash)
      .execute();
    return { kind: "changed", version: authorized.state.version };
  });
}

export async function listInvites(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  after?: string,
): Promise<z.infer<typeof InvitesOutcomeSchema>> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    let query = database
      .selectFrom("invites")
      .selectAll()
      .orderBy("token_hash")
      .limit(101);
    if (after) query = query.where("token_hash", ">", after);
    const rows = await query.execute();
    return {
      kind: "invites",
      invites: rows.slice(0, 100).map((row) => ({
        tokenHash: row.token_hash,
        creatorId: row.creator_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        maxUses: row.max_uses,
        uses: row.uses,
        revoked: row.revoked !== 0,
      })),
      nextCursor: rows.length > 100 ? rows[99]!.token_hash : null,
    };
  });
}
