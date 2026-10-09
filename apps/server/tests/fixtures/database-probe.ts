import { DurableObject } from "cloudflare:workers";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";
import {
  appendProbeMessage,
  removeProbeMessage,
  searchProbe,
  snapshotProbe,
} from "@tests/fixtures/probe-operations";
import {
  failingMigrations,
  initialMigrations,
  successfulMigrations,
  type FailureStage,
  type ProbeCommand,
  type ProbeDatabase,
} from "@tests/fixtures/probe-schema";

/** Test-only actor: absent from the production entry point, bindings and namespace migrations. */
export class DatabaseProbeDO extends DurableObject<Env> {
  private readonly database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Fresh fixtures start at v1 to exercise upgrade failures. Reconstructed v2
    // fixtures must use the supported v2 stream, as a real new release would.
    const hasLedger =
      ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vaskel_schema_migrations'",
        )
        .toArray().length > 0;
    const isUpgraded =
      hasLedger &&
      ctx.storage.sql
        .exec("SELECT version FROM vaskel_schema_migrations WHERE version >= 2")
        .toArray().length > 0;
    migrateActorStorage(
      ctx.storage,
      isUpgraded ? successfulMigrations : initialMigrations,
      { schema: "message_owner", actorId: ctx.id.toString() },
    );
    this.database = createActorDatabase<ProbeDatabase>(ctx.storage);
  }

  append(command: ProbeCommand, failAfter?: FailureStage) {
    return appendProbeMessage(
      this.ctx.storage,
      this.database,
      command,
      failAfter === undefined ? {} : { failAfter },
    );
  }

  remove(messageId: string, fail = false) {
    return removeProbeMessage(this.ctx.storage, this.database, messageId, {
      fail,
    });
  }

  snapshot() {
    return snapshotProbe(this.ctx.storage, this.database);
  }

  search(query: string) {
    return searchProbe(this.database, query);
  }

  pruneReplay() {
    return this.ctx.storage.transaction(async () => {
      await this.database.deleteFrom("events").execute();
    });
  }

  upgrade(fail: boolean) {
    return migrateActorStorage(
      this.ctx.storage,
      fail ? failingMigrations : successfulMigrations,
      { schema: "message_owner", actorId: this.ctx.id.toString() },
    );
  }
}
