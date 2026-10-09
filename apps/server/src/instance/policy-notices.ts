import { identityDatabase } from "@/server/auth/database";
import { instanceLimit } from "@/server/domain/instance-limits";
import { BoundedWork } from "@/server/actors/shared/bounded-work";

/** Best-effort capability refresh; invitation creation always reads primary policy. */
export async function publishInstancePolicyHints(env: Env) {
  const rows = await identityDatabase(env)
    .selectFrom("resource_directory")
    .select("id")
    .where("kind", "=", "server")
    .where("lifecycle", "=", "ready")
    .orderBy("id")
    .limit(instanceLimit("INSTANCE_SERVER_LIMIT", env.INSTANCE_SERVER_LIMIT))
    .execute();
  await new BoundedWork(4).map(rows, ({ id }) =>
    env.SERVER_DO.getByName(id).publishDirectoryHints(),
  );
}
