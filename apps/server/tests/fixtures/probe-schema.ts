import type { ActorMigration } from "@/server/storage/actor-migrations";
import initialSchema from "@tests/fixtures/migrations/0001_message_probe.sql";
import failedUpgrade from "@tests/fixtures/migrations/0002_failed_upgrade.sql";
import successfulUpgrade from "@tests/fixtures/migrations/0002_probe_upgrade.sql";

export const initialMigrations = [
  { version: 1, name: "message_probe", sql: initialSchema },
] satisfies readonly ActorMigration[];

export const successfulMigrations = [
  ...initialMigrations,
  { version: 2, name: "message_revision", sql: successfulUpgrade },
] satisfies readonly ActorMigration[];

export const failingMigrations = [
  ...initialMigrations,
  { version: 2, name: "rejected_upgrade", sql: failedUpgrade },
] satisfies readonly ActorMigration[];

export interface ProbeDatabase {
  owner_state: { id: number; high_water: number; search_policy: string };
  messages: { id: string; author_id: string; body: string; sequence: number };
  events: { sequence: number; message_id: string };
  command_receipts: {
    actor_id: string;
    operation: "send";
    command_id: string;
    payload: string;
    message_id: string;
    sequence: number;
  };
}

export interface ProbeCommand {
  actorId: string;
  commandId: string;
  body: string;
}

export interface ProbeReceipt {
  messageId: string;
  sequence: number;
}

export type ProbeOutcome =
  { kind: "accepted"; receipt: ProbeReceipt } | { kind: "command_conflict" };

export type FailureStage = "message" | "fts" | "event" | "receipt";
