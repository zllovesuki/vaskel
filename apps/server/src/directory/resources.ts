import { BoundedWork } from "@/server/actors/shared/bounded-work";
import type { z } from "zod";
import { sql } from "kysely";
import {
  CreateServerRequestSchema,
  ResourceCreatedSchema,
  ResourceDirectorySchema,
  type ResourceSummary,
} from "@vaskel/contracts/directory";
import { type OwnerScope } from "@vaskel/contracts/messaging";
import type { IdentityPrincipal } from "@/server/auth/principal";
import {
  liveIdentity,
  serverCreationPermission,
} from "@/server/auth/sql-authority";
import { prepareD1Query } from "@/server/storage/d1-database";
import { directoryDatabase } from "./database";
import { directConversationId, stableId } from "./identifiers";
import { reserveResource } from "@/server/directory/admission";
import { actorPrincipal, ownerStub } from "./owners";
import { instanceInvitePolicy } from "@/server/instance/settings";

export async function canCreateServers(
  env: Env,
  principal: IdentityPrincipal,
): Promise<boolean> {
  if (principal.isOperator) return true;
  const grant = await directoryDatabase(env)
    .selectFrom("instance_capability")
    .select("create_servers")
    .where("user_id", "=", principal.userId)
    .executeTakeFirst();
  return grant?.create_servers === 1;
}

async function publishDirectory(
  env: Env,
  principal: IdentityPrincipal,
  owner: OwnerScope,
  members: string[],
  session?: D1DatabaseSession,
): Promise<boolean> {
  const database = directoryDatabase(env, session);
  const binding = session ?? env.IDENTITY_DB;
  const permission =
    owner.kind === "server"
      ? serverCreationPermission(principal.userId)
      : sql<boolean>`1 = 1`;
  const guard = sql<boolean>`(${liveIdentity(principal)} AND ${permission})`;
  const statements = members.map((userId) =>
    database
      .insertInto("resource_membership_index")
      .columns(["resource_id", "user_id"])
      .expression(
        database
          .selectNoFrom((expression) => [
            expression.val(owner.id).as("resource_id"),
            expression.val(userId).as("user_id"),
          ])
          .where(guard),
      )
      .onConflict((conflict) =>
        conflict.columns(["resource_id", "user_id"]).doNothing(),
      )
      .compile(),
  );
  statements.push(
    database
      .updateTable("resource_directory")
      .set({ lifecycle: "ready" })
      .where("id", "=", owner.id)
      .where(guard)
      .returning("id")
      .compile(),
  );
  // The actor is already initialized; publication of every navigation membership
  // and the ready flag is one independent D1 commit with fresh identity authority.
  const result = await binding.batch(
    statements.map((statement) => prepareD1Query(binding, statement)),
  );
  const published = result.at(-1)?.results.length === 1;
  if (published) {
    try {
      await ownerStub(env, owner).publishDirectoryHints();
    } catch {
      /* Directory publication is durable; hints are best effort. */
    }
  }
  return published;
}

export async function createServer(
  env: Env,
  principal: IdentityPrincipal,
  input: z.infer<typeof CreateServerRequestSchema>,
  session?: D1DatabaseSession,
): Promise<z.infer<typeof ResourceCreatedSchema>> {
  if (!(await canCreateServers(env, principal))) return { kind: "forbidden" };
  const firstChannelName = input.firstChannelName ?? "general";
  const id = await stableId("server", principal.userId, input.commandId);
  const reserved = await reserveResource(
    env,
    principal,
    {
      id,
      kind: "server",
      name: input.name,
      creatorId: principal.userId,
      payload: {
        name: input.name,
        ownerId: principal.userId,
        firstChannelName,
      },
    },
    session,
  );
  if (reserved.kind !== "reserved") return reserved;
  const initialized = await env.SERVER_DO.getByName(id).initialize({
    serverId: id,
    name: input.name,
    ownerId: principal.userId,
    firstChannelName,
  });
  if (initialized.kind !== "initialized") return initialized;
  if (
    !(await publishDirectory(
      env,
      principal,
      { kind: "server", id },
      [principal.userId],
      session,
    ))
  )
    return { kind: "forbidden" };
  return {
    kind: "created",
    owner: { kind: "server", id },
    channelId: initialized.channelId,
  };
}

export async function createConversation(
  env: Env,
  principal: IdentityPrincipal,
  targetId: string,
  session?: D1DatabaseSession,
): Promise<z.infer<typeof ResourceCreatedSchema>> {
  if (targetId === principal.userId) return { kind: "invalid_input" };
  const database = directoryDatabase(env, session);
  const people = await database
    .selectFrom("identity_user")
    .select(["id", "name"])
    .where("id", "in", [principal.userId, targetId])
    .where("emailVerified", "=", 1)
    .execute();
  if (people.length !== 2) return { kind: "not_found" };
  const participants = [principal.userId, targetId].sort();
  const id = await directConversationId(principal.userId, targetId);
  const reserved = await reserveResource(
    env,
    principal,
    {
      id,
      kind: "conversation",
      name: people.map((person) => person.name).join(", "),
      creatorId: principal.userId,
      payload: { participants },
    },
    session,
  );
  if (reserved.kind !== "reserved") return reserved;
  const initialized = await env.CONVERSATION_DO.getByName(id).initialize({
    conversationId: id,
    participantIds: participants,
  });
  if (initialized.kind !== "initialized") return initialized;
  if (
    !(await publishDirectory(
      env,
      principal,
      { kind: "conversation", id },
      participants,
      session,
    ))
  )
    return { kind: "forbidden" };
  return {
    kind: "created",
    owner: { kind: "conversation", id },
    channelId: initialized.channelId,
  };
}

export async function listResources(
  env: Env,
  principal: IdentityPrincipal,
  after: string | undefined,
  session?: D1DatabaseSession,
): Promise<z.infer<typeof ResourceDirectorySchema>> {
  const database = directoryDatabase(env, session);
  let query = database
    .selectFrom("resource_membership_index as membership")
    .innerJoin(
      "resource_directory as resource",
      "resource.id",
      "membership.resource_id",
    )
    .select(["resource.id", "resource.kind", "resource.name"])
    .where("membership.user_id", "=", principal.userId)
    .where("resource.lifecycle", "=", "ready")
    .orderBy("resource.id")
    .limit(51);
  if (after) query = query.where("resource.id", ">", after);
  const rows = await query.execute();
  const invitePolicy = await instanceInvitePolicy(env);
  const resources: ResourceSummary[] = [];
  let partial = false;
  const candidates = rows.slice(0, 50);
  const results = await new BoundedWork(8).map(candidates, async (row) =>
    ownerStub(env, { kind: row.kind, id: row.id }).directory(
      actorPrincipal(principal),
      invitePolicy,
    ),
  );
  for (const [index, outcome] of results.entries()) {
    if (outcome.ok && outcome.value.kind === "directory") {
      const row = candidates[index]!;
      const result = outcome.value;
      resources.push({
        owner: { kind: row.kind, id: row.id },
        name: row.kind === "conversation" ? row.name : result.name,
        version: result.version,
        role: result.role,
        ...(result.membersMayInvite !== undefined
          ? {
              membersMayInvite: result.membersMayInvite,
              canCreateInvite: result.canCreateInvite,
            }
          : {}),
        channels: result.channels,
        ...(result.participantIds
          ? { participantIds: result.participantIds }
          : {}),
      });
    } else if (
      !outcome.ok ||
      (outcome.value.kind !== "forbidden" && outcome.value.kind !== "not_found")
    ) {
      partial = true;
    }
  }
  return {
    kind: "directory",
    resources,
    canCreateServers: await canCreateServers(env, principal),
    partial,
    nextCursor: rows.length > 50 ? (rows[49]?.id ?? null) : null,
  };
}
