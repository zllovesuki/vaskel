import {
  logEvent,
  type ActorMigrationDiagnosticContext,
} from "@/server/telemetry";

export interface ActorMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Bounded startup DDL only. Large conversions need their own resumable maintenance path. */
export function migrateActorStorage(
  storage: DurableObjectStorage,
  migrations: readonly ActorMigration[],
  context: {
    schema: ActorMigrationDiagnosticContext["schema"];
    actorId?: string | undefined;
  },
): number {
  let diagnostic: ActorMigrationDiagnosticContext = {
    schema: context.schema,
    phase: "validate_plan",
    supportedVersion: migrations.length,
  };
  try {
    for (const [index, migration] of migrations.entries()) {
      if (migration.version !== index + 1 || migration.name.length === 0) {
        diagnostic.reason = "invalid_plan";
        diagnostic.migrationVersion = migration.version;
        diagnostic.expectedVersion = index + 1;
        throw new Error(
          "Actor migrations must be named and contiguous from version 1.",
        );
      }
    }

    // Let errors leave the native boundary before reporting, so all pending DDL
    // and ledger writes roll back together and construction still fails.
    diagnostic.phase = "transaction";
    return storage.transactionSync(() => {
      diagnostic.phase = "create_ledger";
      storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS vaskel_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      ) STRICT
    `);
      diagnostic.phase = "read_ledger";
      const applied = storage.sql
        .exec<{ version: number; name: string }>(
          "SELECT version, name FROM vaskel_schema_migrations ORDER BY version",
        )
        .toArray();

      diagnostic.phase = "validate_ledger";
      for (const [index, row] of applied.entries()) {
        const expected = migrations[index];
        if (row.version !== index + 1 || expected?.name !== row.name) {
          diagnostic.reason =
            row.version > migrations.length
              ? "schema_ahead"
              : row.version !== index + 1
                ? "ledger_gap"
                : "name_mismatch";
          diagnostic.observedVersion = row.version;
          if (diagnostic.reason === "ledger_gap")
            diagnostic.expectedVersion = index + 1;
          throw new Error(
            "Actor schema is newer than or incompatible with this code.",
          );
        }
      }

      for (const migration of migrations.slice(applied.length)) {
        diagnostic.migrationVersion = migration.version;
        diagnostic.migrationName = migration.name;
        diagnostic.phase = "execute_sql";
        storage.sql.exec(migration.sql);
        diagnostic.phase = "write_ledger";
        storage.sql.exec(
          "INSERT INTO vaskel_schema_migrations (version, name) VALUES (?, ?)",
          migration.version,
          migration.name,
        );
      }
      diagnostic = {
        schema: context.schema,
        phase: "transaction",
        supportedVersion: migrations.length,
      };
      return migrations.length;
    });
  } catch (error) {
    logEvent(
      "error",
      "actor_migration_failed",
      {
        ...diagnostic,
        actorId: context.actorId,
      },
      error,
    );
    throw error;
  }
}
