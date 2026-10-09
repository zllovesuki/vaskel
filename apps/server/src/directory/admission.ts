import { expressionBuilder, sql, type InferResult } from "kysely";
import type { InstanceCapacityFailure } from "@vaskel/contracts/instance-capacity";
import type { MessagingFailure } from "@vaskel/contracts/messaging";
import type { IdentityPrincipal } from "@/server/auth/principal";
import {
  liveIdentity,
  serverCreationPermission,
} from "@/server/auth/sql-authority";
import { instanceLimit } from "@/server/domain/instance-limits";
import { prepareD1Query } from "@/server/storage/d1-database";
import {
  directoryDatabase,
  type DirectoryDatabase,
} from "@/server/directory/database";
import { payloadHash } from "@/server/directory/identifiers";

/** The pending row is both the durable creation receipt and the charged slot. */
export async function reserveResource(
  env: Env,
  principal: IdentityPrincipal,
  input: {
    id: string;
    kind: "server" | "conversation";
    name: string;
    creatorId: string;
    payload: unknown;
  },
  session?: D1DatabaseSession,
): Promise<{ kind: "reserved" } | MessagingFailure | InstanceCapacityFailure> {
  const binding = session ?? env.IDENTITY_DB.withSession("first-primary");
  const database = directoryDatabase(env, binding);
  const hash = await payloadHash(input.payload);
  const limit =
    input.kind === "server"
      ? instanceLimit("INSTANCE_SERVER_LIMIT", env.INSTANCE_SERVER_LIMIT)
      : instanceLimit(
          "INSTANCE_CONVERSATION_LIMIT",
          env.INSTANCE_CONVERSATION_LIMIT,
        );
  const permission =
    input.kind === "server"
      ? serverCreationPermission(principal.userId)
      : sql<boolean>`1 = 1`;
  const atCapacity = expressionBuilder<DirectoryDatabase>()(
    database
      .selectFrom("resource_directory")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("kind", "=", input.kind),
    ">=",
    limit,
  );
  const insert = database
    .insertInto("resource_directory")
    .columns([
      "id",
      "kind",
      "name",
      "creator_id",
      "lifecycle",
      "payload_hash",
      "created_at",
    ])
    .expression(
      database
        .selectNoFrom((expression) => [
          expression.val(input.id).as("id"),
          expression.val(input.kind).as("kind"),
          expression.val(input.name).as("name"),
          expression.val(input.creatorId).as("creator_id"),
          expression.val("pending").as("lifecycle"),
          expression.val(hash).as("payload_hash"),
          expression.val(Date.now()).as("created_at"),
        ])
        .where(liveIdentity(principal))
        .where(permission)
        .where(atCapacity, "=", 0),
    )
    .onConflict((conflict) => conflict.column("id").doNothing())
    .compile();
  const classify = database
    .selectFrom(
      database.selectNoFrom((eb) => eb.lit(1).as("id")).as("admission"),
    )
    .leftJoin("resource_directory as resource", (join) =>
      join.on("resource.id", "=", input.id),
    )
    .select(["resource.kind", "resource.payload_hash"])
    .select(atCapacity.as("at_capacity"))
    .where(liveIdentity(principal))
    .where(permission);
  // The write routes the entire native batch to primary even if a caller passed
  // a replica-eligible session. Classification observes the same atomic state;
  // no stale replica or later count change can turn capacity into another error.
  const results = await binding.batch<InferResult<typeof classify>[number]>([
    prepareD1Query(binding, insert),
    prepareD1Query(binding, classify.compile()),
  ]);
  const current = results[1]?.results[0];
  if (!current) return { kind: "forbidden" };
  // Accepted receipts remain resumable at capacity.
  if (current.kind !== null)
    return current.kind === input.kind && current.payload_hash === hash
      ? { kind: "reserved" }
      : { kind: "command_conflict" };
  if (current.at_capacity === 1) return { kind: "instance_capacity" };
  throw new Error("Resource admission did not produce a receipt.");
}
