import type { Kysely } from "kysely";
import type { AccountEventHint } from "@vaskel/contracts/account-events";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { OwnerDatabase } from "./database";
import { isDirectRecipient } from "./notification-source";
import {
  access,
  channelReaders,
  getState,
  membership,
  ownerScope,
} from "./policy";
import type { Principal } from "@/server/domain/principal";
import { actorWork, ACTOR_WORK_BUDGET_MS } from "./bounded-work";
import {
  eventDispatchStub,
  groupEventDispatchRecipients,
} from "@/server/event-dispatch/routing";
import { logEvent } from "@/server/telemetry";

/** Send-time addressing stays in the owner; each reader only learns whether it was addressed. */
export type CommitHint =
  | (Omit<Extract<AccountEventHint, { type: "activity" }>, "direct"> & {
      authorId: string;
      mentioned: string[];
      quoteAuthorId: string | undefined;
    })
  | Extract<AccountEventHint, { type: "mutation" }>;

/** Each invocation carries one payload, so private reads cannot inherit another audience. */
function deliver(
  ctx: DurableObjectState,
  env: Env,
  recipients: string[],
  notice: AccountEventHint,
  authorize: (recipients: string[]) => Promise<string[]>,
) {
  const deadline = Date.now() + ACTOR_WORK_BUDGET_MS;
  // Recipient latency cannot delay an accepted command. Overlapping commands share a cap.
  ctx.waitUntil(
    actorWork(ctx.storage, "hints")
      .map(
        groupEventDispatchRecipients(recipients),
        async (group) => {
          const current = await authorize(group.recipients);
          if (current.length && Date.now() < deadline)
            await eventDispatchStub(env, current[0]!).deliver({
              recipients: current,
              notice,
            });
        },
        deadline,
      )
      .then((results) => {
        const failed = results.filter((result) => !result.ok).length;
        if (failed)
          logEvent("warn", "event_hint_delivery_failed", {
            actorId: ctx.id.toString(),
            processed: results.length,
            failed,
          });
      })
      .catch((error) =>
        logEvent(
          "warn",
          "event_hint_delivery_failed",
          { actorId: ctx.id.toString() },
          error,
        ),
      ),
  );
}

export async function notifyCommit(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
  notice: CommitHint,
): Promise<string[]> {
  if (notice.type !== "activity") {
    await notifyChannelHint(ctx, env, db, notice);
    return [];
  }
  const { authorId, mentioned, quoteAuthorId, ...hint } = notice;
  const audience = channelAudience(ctx, db, hint, authorId);
  const recipients = await audience();
  const named = new Set(mentioned);
  const addressed: string[] = [];
  const others: string[] = [];
  for (const userId of recipients)
    (isDirectRecipient(
      hint.owner.kind,
      named.has(userId),
      quoteAuthorId,
      userId,
    )
      ? addressed
      : others
    ).push(userId);
  // Separate payloads, so no reader learns how another reader was addressed.
  if (addressed.length > 0)
    deliver(ctx, env, addressed, { ...hint, direct: true }, audience);
  if (others.length > 0)
    deliver(ctx, env, others, { ...hint, direct: false }, audience);
  // Push candidates share this selection; detached hints still recheck each batch.
  return recipients;
}

export async function notifyChannelHint(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
  notice: Extract<AccountEventHint, { channelId: string }>,
  excludeUserId?: string,
) {
  const audience = channelAudience(ctx, db, notice, excludeUserId);
  deliver(ctx, env, await audience(), notice, audience);
}

/** Current readers of the hinted channel, optionally narrowed to earlier candidates. */
function channelAudience(
  ctx: DurableObjectState,
  db: Kysely<OwnerDatabase>,
  notice: { owner: OwnerScope; channelId: string; generation?: string },
  excludeUserId?: string,
) {
  return (candidates?: string[]) =>
    ctx.storage.transaction(async () => {
      const state = await getState(db);
      if (
        !state ||
        state.owner_id !== notice.owner.id ||
        state.owner_kind !== notice.owner.kind ||
        (notice.generation !== undefined &&
          state.generation !== notice.generation)
      )
        return [];
      let query = channelReaders(db, notice.channelId);
      if (excludeUserId) query = query.where("user_id", "!=", excludeUserId);
      if (!candidates) return (await query.execute()).map((row) => row.user_id);
      const recipients: string[] = [];
      // Hub payloads may exceed SQLite's bind limit; every chunk shares this transaction.
      for (let index = 0; index < candidates.length; index += 64) {
        const rows = await query
          .where("user_id", "in", candidates.slice(index, index + 64))
          .execute();
        recipients.push(...rows.map((row) => row.user_id));
      }
      return recipients;
    });
}

export async function notifyRead(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
  principal: Principal,
  channelId: string,
) {
  const notice = await ctx.storage.transaction(async () => {
    const authorized = await access(db, principal, channelId);
    if (authorized.kind !== "authorized") return null;
    const read = await db
      .selectFrom("read_cursors")
      .select("sequence")
      .where("user_id", "=", principal.userId)
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    if (!read) return null;
    return {
      type: "read",
      owner: ownerScope(authorized.state),
      channelId,
      generation: authorized.state.generation,
      sequence: read.sequence,
    } satisfies AccountEventHint;
  });
  if (notice)
    deliver(ctx, env, [principal.userId], notice, () =>
      ctx.storage.transaction(async () => {
        const current = await access(db, principal, channelId);
        return current.kind === "authorized" &&
          current.state.generation === notice.generation
          ? [principal.userId]
          : [];
      }),
    );
}

/** Owner-level hints still recheck membership immediately before each grouped dispatch. */
async function notifyOwner(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
  type: "directory" | "dm_policy" | "presence",
  options: { removedUserId?: string | undefined; changedUserId?: string } = {},
) {
  const selection = await ctx.storage.transaction(async () => {
    const state = await getState(db);
    // A block-only pair has no owner state and must remain undisclosed.
    if (
      !state ||
      (type === "dm_policy" && state.owner_kind !== "conversation") ||
      (options.changedUserId && !(await membership(db, options.changedUserId)))
    )
      return null;
    const rows = await db.selectFrom("members").select("user_id").execute();
    const recipients = new Set(rows.map((row) => row.user_id));
    if (options.removedUserId) recipients.add(options.removedUserId);
    return {
      recipients: [...recipients],
      notice: (type === "presence"
        ? { type, owner: ownerScope(state), userId: options.changedUserId! }
        : { type, owner: ownerScope(state) }) satisfies AccountEventHint,
    };
  });
  if (!selection) return;
  deliver(ctx, env, selection.recipients, selection.notice, (candidates) =>
    ctx.storage.transaction(async () => {
      const state = await getState(db);
      if (
        !state ||
        state.owner_id !== selection.notice.owner.id ||
        state.owner_kind !== selection.notice.owner.kind ||
        (options.changedUserId &&
          !(await membership(db, options.changedUserId)))
      )
        return [];
      const current = new Set<string>();
      for (let index = 0; index < candidates.length; index += 64) {
        const members = await db
          .selectFrom("members")
          .select("user_id")
          .where("user_id", "in", candidates.slice(index, index + 64))
          .execute();
        for (const member of members) current.add(member.user_id);
      }
      if (options.removedUserId && candidates.includes(options.removedUserId))
        current.add(options.removedUserId);
      return [...current];
    }),
  );
}
export function notifyDirectory(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
  removedUserId?: string,
) {
  return notifyOwner(ctx, env, db, "directory", { removedUserId });
}
export function notifyDmPolicy(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
) {
  return notifyOwner(ctx, env, db, "dm_policy");
}
export function notifyPresence(
  ctx: DurableObjectState,
  env: Env,
  db: Kysely<OwnerDatabase>,
  changedUserId: string,
) {
  return notifyOwner(ctx, env, db, "presence", { changedUserId });
}
