import { Kysely, type CompiledQuery } from "kysely";
import { D1Dialect, type D1DialectConfig } from "kysely-d1";
import type { IdentityDatabase } from "./identity-schema";

export function createD1Database<Database = IdentityDatabase>(
  database: D1Database | D1DatabaseSession,
) {
  // kysely-d1@0.4.0's driver only calls prepare().bind().all(), which native
  // D1 sessions support. Its older declaration requires the whole binding.
  // Keep the precise package-type bridge here; callers still supply only real
  // bindings/sessions. workerd tests cover session queries and native batches.
  const dialectDatabase = database as D1DialectConfig["database"];
  return new Kysely<Database>({
    dialect: new D1Dialect({ database: dialectDatabase }),
  });
}

/** Compile first, then submit the complete atomic statement list to native D1.batch(). */
export function prepareD1Query(
  database: D1Database | D1DatabaseSession,
  query: CompiledQuery,
) {
  return database.prepare(query.sql).bind(...query.parameters);
}
