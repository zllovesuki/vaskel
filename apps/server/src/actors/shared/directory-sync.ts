import type { Kysely } from "kysely";
import { OWNER_MEMBER_LIMIT } from "@vaskel/contracts/resources";
import { directoryDatabase } from "@/server/directory/database";
import type { OwnerDatabase } from "./database";
import { getState } from "./policy";
export const DIRECTORY_SYNC_AT = "directory-sync-at";
import { scheduleAlarm } from "./alarms";
import { actorWork, ACTOR_WORK_BUDGET_MS } from "./bounded-work";

const RETRY_MS = 30_000;
const BATCH_SIZE = 40;

/** Called inside the native transaction admitting membership. */
export async function queueDirectorySync(storage: DurableObjectStorage) {
  const due = Math.min(
    Date.now(),
    (await storage.get<number>(DIRECTORY_SYNC_AT)) ?? Infinity,
  );
  await storage.put(DIRECTORY_SYNC_AT, due);
  await scheduleAlarm(storage, due);
}

/** References only nominate owners; each directory read still checks membership. */
export async function publishMembershipBatch(
  env: Pick<Env, "IDENTITY_DB">,
  resourceId: string,
  userIds: readonly string[],
) {
  await directoryDatabase(env)
    .insertInto("resource_membership_index")
    .values(
      userIds.map((userId) => ({ resource_id: resourceId, user_id: userId })),
    )
    .onConflict((conflict) =>
      conflict.columns(["resource_id", "user_id"]).doNothing(),
    )
    .execute();
}

export async function drainDirectorySync(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  publish: (resourceId: string, userIds: readonly string[]) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + ACTOR_WORK_BUDGET_MS;
  const snapshot = await storage.transaction(async () => {
    const due = await storage.get<number>(DIRECTORY_SYNC_AT);
    if (due === undefined || due > Date.now()) return;
    const state = await getState(database);
    if (!state || state.owner_kind !== "server") return;
    const members = await database
      .selectFrom("members")
      .select("user_id")
      .orderBy("user_id")
      .limit(OWNER_MEMBER_LIMIT)
      .execute();
    // The sole durable marker also backs off failed/lost acknowledgements.
    // Arm recovery before any D1 I/O, including an interrupted partial pass.
    const retryAt = Date.now() + RETRY_MS;
    await storage.put(DIRECTORY_SYNC_AT, retryAt);
    await scheduleAlarm(storage, retryAt);
    return { state, members };
  });
  if (!snapshot) return false;
  const work = actorWork(storage, "maintenance");
  for (let offset = 0; offset < snapshot.members.length; offset += BATCH_SIZE) {
    const result = await work.run(
      () =>
        publish(
          snapshot.state.owner_id,
          snapshot.members
            .slice(offset, offset + BATCH_SIZE)
            .map((member) => member.user_id),
        ),
      deadline,
      "directory-sync",
    );
    if (!result.ok) return false;
  }
  return storage.transaction(async () => {
    const current = await getState(database);
    // A join during publication retains its earlier deadline for another pass.
    if (current?.version !== snapshot.state.version) return false;
    await storage.delete(DIRECTORY_SYNC_AT);
    return true;
  });
}
