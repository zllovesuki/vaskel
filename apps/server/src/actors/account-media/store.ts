import migration from "./migrations/0001_initial.sql?raw";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";
import {
  AccountReceiptSchema,
  ParticipationSchema,
  type AccountState,
} from "./state";

// This actor reads and commits its one complete participation, never queries its
// individual fields. Store the validated variant without nullable column pairs.
interface AccountDatabase {
  account_media: {
    id: number;
    user_id: string;
    generation: number;
    participation: string;
    receipt: string | null;
  };
}
export function accountDatabase(
  storage: DurableObjectStorage,
  actorId?: string,
) {
  migrateActorStorage(
    storage,
    [{ version: 1, name: "account-media-initial", sql: migration }],
    { schema: "account_media", actorId },
  );
  return createActorDatabase<AccountDatabase>(storage);
}

export async function findAccountState(
  database: ReturnType<typeof accountDatabase>,
): Promise<AccountState | undefined> {
  const row = await database
    .selectFrom("account_media")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!row) return;
  return {
    userId: row.user_id,
    generation: row.generation,
    participation: ParticipationSchema.parse(JSON.parse(row.participation)),
    receipt:
      row.receipt === null
        ? null
        : AccountReceiptSchema.parse(JSON.parse(row.receipt)),
  };
}

export async function readAccountState(
  database: ReturnType<typeof accountDatabase>,
  userId: string,
  initialize = true,
): Promise<AccountState> {
  let state = await findAccountState(database);
  if (!state) {
    state = {
      userId,
      generation: 0,
      participation: { kind: "idle" },
      receipt: null,
    };
    if (initialize)
      await database
        .insertInto("account_media")
        .values(storedState(state))
        .execute();
  }
  return state;
}

function storedState(state: AccountState) {
  return {
    id: 1,
    user_id: state.userId,
    generation: state.generation,
    participation: JSON.stringify(state.participation),
    receipt: state.receipt === null ? null : JSON.stringify(state.receipt),
  };
}

export function saveAccountState(
  database: ReturnType<typeof accountDatabase>,
  state: AccountState,
) {
  const row = storedState(state);
  return database
    .insertInto("account_media")
    .values(row)
    .onConflict((conflict) => conflict.column("id").doUpdateSet(row))
    .execute();
}
