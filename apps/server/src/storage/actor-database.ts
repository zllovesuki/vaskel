import { Kysely } from "kysely";
import {
  DurableObjectSqliteDialect,
  type SqlStorage as DialectSqlStorage,
} from "kysely-durable-objects";

/** Queries execute on this actor's own SQL handle; use its native storage transaction. */
export function createActorDatabase<Database>(storage: DurableObjectStorage) {
  return new Kysely<Database>({
    // Version 0.2.2 declares exec<T> without native SqlStorage's SQLite-row constraint.
    // Bridge only that private declaration mismatch; the identical SQL handle is used.
    // This is not input validation. Real workerd queries/rollback are regression-tested.
    dialect: new DurableObjectSqliteDialect(storage.sql as DialectSqlStorage),
  });
}
