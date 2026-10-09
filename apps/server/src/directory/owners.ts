import { z } from "zod";
import { sql } from "kysely";
import { directoryDatabase } from "./database";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { IdentityPrincipal } from "@/server/auth/principal";
import type { Principal } from "@/server/domain/principal";

export function ownerStub(env: Env, owner: OwnerScope) {
  return owner.kind === "server"
    ? env.SERVER_DO.getByName(owner.id)
    : env.CONVERSATION_DO.getByName(owner.id);
}

export function actorPrincipal(principal: IdentityPrincipal): Principal {
  // Identity extras stay in the Worker; the actor accepts one executable trusted-context shape.
  return {
    userId: principal.userId,
    sessionId: principal.sessionId,
    expiresAt: Math.min(principal.expiresAt, principal.verifiedAt + 30_000),
  };
}

/** A ready directory owner and its actor stub, resolved by ingress before any body is read. */
export interface KnownOwner {
  owner: OwnerScope;
  stub: ReturnType<typeof ownerStub>;
}
const ResourcePathSchema = z.strictObject({
  kind: z.enum(["server", "conversation"]),
  id: z.uuid(),
});
export async function knownOwner(
  env: Env,
  kind: string | undefined,
  id: string | undefined,
  session?: D1DatabaseSession,
): Promise<KnownOwner | null> {
  const parsed = ResourcePathSchema.safeParse({ kind, id });
  if (!parsed.success) return null;
  const row = await directoryDatabase(env, session)
    .selectFrom("resource_directory")
    .select("id")
    .where("id", "=", parsed.data.id)
    .where("kind", "=", parsed.data.kind)
    .where("lifecycle", "=", "ready")
    .executeTakeFirst();
  return row ? { owner: parsed.data, stub: ownerStub(env, parsed.data) } : null;
}

/** Request-local discovery for bounded, validated owner scopes. */
export async function knownOwners(
  env: Env,
  owners: readonly OwnerScope[],
  session?: D1DatabaseSession,
): Promise<Map<string, KnownOwner>> {
  const requested = new Map(owners.map((owner) => [ownerKey(owner), owner]));
  if (requested.size === 0) return new Map();
  const values = [...requested.values()].map(
    (owner) => sql`(${owner.id}, ${owner.kind})`,
  );
  const result = await sql<OwnerScope>`
    WITH requested(id, kind) AS (VALUES ${sql.join(values)})
    SELECT resource.id, resource.kind
    FROM requested CROSS JOIN resource_directory AS resource
      ON resource.id = requested.id AND resource.kind = requested.kind
    WHERE resource.lifecycle = 'ready'
  `.execute(directoryDatabase(env, session));
  return new Map(
    result.rows.map((owner) => [
      ownerKey(owner),
      { owner, stub: ownerStub(env, owner) },
    ]),
  );
}

export function ownerKey(owner: OwnerScope): string {
  return `${owner.kind}:${owner.id}`;
}
