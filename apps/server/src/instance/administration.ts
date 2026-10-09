import { BoundedWork } from "@/server/actors/shared/bounded-work";
import { OPERATOR_PAGE_LIMIT } from "@vaskel/contracts/instance";
import { identityDatabase } from "@/server/auth/database";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { actorPrincipal, ownerStub } from "@/server/directory/owners";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { liveOperator } from "@/server/auth/sql-authority";

export async function operatorAccounts(
  env: Env,
  principal: IdentityPrincipal,
  after?: string,
) {
  const rows = await identityDatabase(env)
    .selectFrom("identity_user")
    .select(["id", "name as displayName", "emailVerified", "createdAt"])
    .where("id", ">", after ?? "")
    .where(liveOperator(principal))
    .orderBy("id")
    .limit(OPERATOR_PAGE_LIMIT + 1)
    .execute();
  const page = rows.slice(0, OPERATOR_PAGE_LIMIT);
  const partial = rows.length > OPERATOR_PAGE_LIMIT;
  return {
    kind: "accounts" as const,
    accounts: page.map(({ emailVerified, ...row }) => ({
      ...row,
      verified: emailVerified === 1,
    })),
    nextAfter: partial ? page.at(-1)!.id : null,
    partial,
  };
}

export async function operatorUsage(
  env: Env,
  principal: IdentityPrincipal,
  after?: string,
) {
  const assertion = { ...actorPrincipal(principal), isOperator: true as const };
  const rows = await identityDatabase(env)
    .selectFrom("resource_directory")
    .select(["id", "kind"])
    .where("id", ">", after ?? "")
    .where(liveOperator(principal))
    .orderBy("id")
    .limit(OPERATOR_PAGE_LIMIT + 1)
    .execute();
  const page = rows.slice(0, OPERATOR_PAGE_LIMIT);
  const owners: {
    owner: OwnerScope;
    sql: import("@vaskel/contracts/capacity").OwnerCapacity["sql"];
    attachments: { chargedBytes: number; budgetBytes: number };
  }[] = [];
  let partial = rows.length > OPERATOR_PAGE_LIMIT;
  const results = await new BoundedWork(4).map(page, async (owner) =>
    ownerStub(env, owner).operatorUsage(assertion),
  );
  for (const [index, result] of results.entries()) {
    if (!result.ok) {
      partial = true;
      continue;
    }
    if (result.value.kind !== "owner_usage") {
      partial = true;
      continue;
    }
    owners.push({
      owner: page[index]!,
      sql: result.value.sql,
      attachments: result.value.attachments,
    });
  }
  return {
    kind: "usage" as const,
    owners,
    nextAfter: rows.length > OPERATOR_PAGE_LIMIT ? page.at(-1)!.id : null,
    partial,
  };
}
