import type { AuthEnvironment } from "./environment";
import { createD1Database } from "@/server/storage/d1-database";

/** Every authentication read starts on primary. */
export function primaryAuthDatabase(env: AuthEnvironment) {
  const database = env.IDENTITY_DB;
  return {
    prepare: (query: string) =>
      database.withSession("first-primary").prepare(query),
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      return database.withSession("first-primary").batch<T>(statements);
    },
    // Better Auth detects its native D1 path by exec/prepare/batch presence.
    // Its inspected D1 adapter executes authentication queries through prepare.
    exec: (query: string) => database.exec(query),
  };
}

export function identitySession(env: AuthEnvironment) {
  return env.IDENTITY_DB.withSession("first-primary");
}

export function identityDatabase(env: AuthEnvironment) {
  return createD1Database(identitySession(env));
}
