import type { Expression, ExpressionBuilder, Kysely, Selectable } from "kysely";
import {
  type OwnerScope,
  type ReplayCursor,
} from "@vaskel/contracts/messaging";
import type { SessionAssertion } from "@/server/domain/principal";
import type { OwnerDatabase, OwnerState } from "./database";

export type AccessFailure = {
  kind: "unauthenticated" | "forbidden" | "not_found";
};

export function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function principalFailure(
  principal: SessionAssertion,
  now = Date.now(),
): { kind: "unauthenticated" } | null {
  return principal.expiresAt <= now ? { kind: "unauthenticated" } : null;
}
export function ownerScope(state: OwnerState): OwnerScope {
  return { kind: state.owner_kind, id: state.owner_id };
}
export function cursor(
  state: OwnerState,
  channelId: string,
  sequence = state.high_water,
): ReplayCursor {
  return {
    owner: ownerScope(state),
    channelId,
    generation: state.generation,
    sequence,
  };
}
export async function getState(database: Kysely<OwnerDatabase>) {
  return database
    .selectFrom("owner_state")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
}
export async function membership(
  database: Kysely<OwnerDatabase>,
  userId: string,
) {
  return database
    .selectFrom("members")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();
}
export interface AuthorizedOwner {
  kind: "authorized";
  state: OwnerState;
  member: Selectable<OwnerDatabase["members"]>;
}
export interface AuthorizedChannel extends AuthorizedOwner {
  channel: Selectable<OwnerDatabase["channels"]>;
}
/**
 * A channel is visible to a member when it is public or lists the member in its
 * roster. `channelReaders` states the same rule from the channel's side; the
 * per-channel check, the set predicates and the reader sets change together.
 */
export function visibleChannels(
  eb: ExpressionBuilder<OwnerDatabase, "channels">,
  userId: string | Expression<string>,
) {
  // Correlated on the channel row so the roster's (channel_id, user_id) key
  // answers each probe; a user-only subquery would scan the roster table.
  return eb.or([
    eb("channels.private", "=", 0),
    eb.exists(
      eb
        .selectFrom("channel_members")
        .select("channel_members.user_id")
        .whereRef("channel_members.channel_id", "=", "channels.id")
        .where("channel_members.user_id", "=", userId),
    ),
  ]);
}
/** Current readers among a bounded candidate set, in the caller's transaction. */
export function readChannelReaders(
  database: Kysely<OwnerDatabase>,
  channelId: string,
  userIds: readonly string[],
) {
  return database
    .selectFrom("channels")
    .innerJoin("members", (join) => join.on("members.user_id", "in", userIds))
    .select("members.user_id")
    .where("channels.id", "=", channelId)
    .where((eb) => visibleChannels(eb, eb.ref("members.user_id")))
    .execute();
}
/** Members who may read one channel; a missing channel has no readers. */
export function channelReaders(
  database: Kysely<OwnerDatabase>,
  channelId: string,
) {
  return database
    .selectFrom("members")
    .select("user_id")
    .where((eb) =>
      eb.or([
        eb(
          eb
            .selectFrom("channels")
            .select("channels.private")
            .where("channels.id", "=", channelId),
          "=",
          0,
        ),
        eb(
          "members.user_id",
          "in",
          eb
            .selectFrom("channel_members")
            .select("channel_members.user_id")
            .where("channel_members.channel_id", "=", channelId),
        ),
      ]),
    );
}
/** Current authority and rows are usable only inside the caller's native transaction. */
export function access(
  database: Kysely<OwnerDatabase>,
  principal: SessionAssertion,
): Promise<AccessFailure | AuthorizedOwner>;
export function access(
  database: Kysely<OwnerDatabase>,
  principal: SessionAssertion,
  channelId: string,
): Promise<AccessFailure | AuthorizedChannel>;
export async function access(
  database: Kysely<OwnerDatabase>,
  principal: SessionAssertion,
  channelId?: string,
): Promise<AccessFailure | AuthorizedOwner | AuthorizedChannel> {
  const invalid = principalFailure(principal);
  if (invalid) return invalid;
  const state = await getState(database);
  if (!state) return { kind: "not_found" };
  const member = await membership(database, principal.userId);
  if (!member) return { kind: "forbidden" };
  if (channelId === undefined) return { kind: "authorized", state, member };
  const channel = await database
    .selectFrom("channels")
    .selectAll()
    .select((eb) => visibleChannels(eb, principal.userId).as("visible"))
    .where("id", "=", channelId)
    .executeTakeFirst();
  if (!channel) return { kind: "not_found" };
  // Server ownership governs administration, but does not grant hidden-channel content access.
  const { visible, ...row } = channel;
  if (!visible) return { kind: "forbidden" };
  return { kind: "authorized", state, member, channel: row };
}
export async function ownerAccess(
  database: Kysely<OwnerDatabase>,
  principal: SessionAssertion,
): Promise<AccessFailure | AuthorizedOwner> {
  const authorized = await access(database, principal);
  if (authorized.kind !== "authorized") return authorized;
  return authorized.member.role === "owner"
    ? authorized
    : { kind: "forbidden" };
}
