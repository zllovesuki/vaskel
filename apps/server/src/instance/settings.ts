import type { IdentityPrincipal } from "@/server/auth/principal";
import { identityDatabase } from "@/server/auth/database";
import { liveOperator } from "@/server/auth/sql-authority";
import {
  InvitePolicySchema,
  OperatorInstanceSchema,
  type InvitePolicy,
} from "@vaskel/contracts/instance";

export async function instanceSettings(env: Env) {
  const row = await identityDatabase(env)
    .selectFrom("instance_settings")
    .select(["name", "icon_key", "icon_type", "invite_policy"])
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!row) throw new Error("Missing instance settings");
  return row;
}
export async function instanceView(env: Env) {
  const row = await instanceSettings(env);
  return OperatorInstanceSchema.parse({
    kind: "instance",
    name: row.name,
    hasIcon: row.icon_key !== null,
    invitePolicy: row.invite_policy,
    tag: env.CF_VERSION_METADATA.tag || null,
  });
}
/** Primary authority is carried only in the trusted RPC context, never client JSON. */
export async function instanceInvitePolicy(env: Env): Promise<InvitePolicy> {
  return InvitePolicySchema.parse((await instanceSettings(env)).invite_policy);
}
export async function updateInstance(
  env: Env,
  principal: IdentityPrincipal,
  input: { name: string; invitePolicy: InvitePolicy },
) {
  const result = await identityDatabase(env)
    .updateTable("instance_settings")
    .set({
      name: input.name,
      invite_policy: input.invitePolicy,
      updated_at: Date.now(),
    })
    .where("id", "=", 1)
    .where(liveOperator(principal))
    .returning("id")
    .execute();
  return result.length ? instanceView(env) : { kind: "forbidden" as const };
}
