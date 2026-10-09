import { BoundedWork } from "@/server/actors/shared/bounded-work";
import { sql } from "kysely";
import type { z } from "zod";
import type { PeopleResponseSchema } from "@vaskel/contracts/directory";
import { PEOPLE_CANDIDATE_LIMIT } from "@/server/domain/people";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { directoryDatabase } from "./database";
import { actorPrincipal, ownerStub } from "./owners";

const OWNER_LIMIT = 50;

export async function searchPeople(
  env: Env,
  principal: IdentityPrincipal,
  query: string,
  session: D1DatabaseSession,
): Promise<z.infer<typeof PeopleResponseSchema>> {
  const assertion = actorPrincipal(principal);
  const candidates = await directoryDatabase(env, session)
    .selectFrom("identity_user as person")
    .innerJoin(
      "resource_membership_index as other",
      "other.user_id",
      "person.id",
    )
    .innerJoin(
      "resource_membership_index as mine",
      "mine.resource_id",
      "other.resource_id",
    )
    .innerJoin(
      "resource_directory as resource",
      "resource.id",
      "mine.resource_id",
    )
    .select([
      "person.id as userId",
      "person.name as displayName",
      "resource.id",
      "resource.kind",
    ])
    .where("person.emailVerified", "=", 1)
    .where("person.id", "!=", principal.userId)
    .where("mine.user_id", "=", principal.userId)
    .where("resource.lifecycle", "=", "ready")
    // Literal matching avoids wildcard interpretation and D1's LIKE pattern byte limit.
    .where(sql<boolean>`instr(lower(person.name), lower(${query})) > 0`)
    .orderBy("person.name")
    .orderBy("person.id")
    .orderBy("resource.id")
    .limit(PEOPLE_CANDIDATE_LIMIT + 1)
    .execute();
  let partial = candidates.length > PEOPLE_CANDIDATE_LIMIT;
  const bounded = candidates.slice(0, PEOPLE_CANDIDATE_LIMIT);
  const owners = [
    ...new Map(
      bounded.map((row) => [row.id, { kind: row.kind, id: row.id }]),
    ).values(),
  ];
  partial ||= owners.length > OWNER_LIMIT;
  const authorizedIds = new Set<string>();
  const candidateIds = [...new Set(bounded.map((row) => row.userId))];
  const results = await new BoundedWork(8).map(
    owners.slice(0, OWNER_LIMIT),
    async (owner) =>
      ownerStub(env, owner).sharedPeople(assertion, candidateIds),
  );
  for (const result of results) {
    if (!result.ok) {
      partial = true;
      continue;
    }
    // D1 only suggests candidates. Both parties must still belong to one
    // owner in the same authoritative transaction before a name is exposed.
    if (result.value.kind === "shared_people") {
      for (const userId of result.value.userIds) authorizedIds.add(userId);
    } else if (
      result.value.kind !== "forbidden" &&
      result.value.kind !== "not_found"
    ) {
      partial = true;
    }
  }
  const people = [
    ...new Map(
      bounded
        .filter((row) => authorizedIds.has(row.userId))
        .map(({ userId, displayName }) => [userId, { userId, displayName }]),
    ).values(),
  ].slice(0, 40);
  return { kind: "people", people, partial };
}
