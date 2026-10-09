import { nativeSocket } from "@tests/helpers/native-socket";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { Principal } from "@/server/domain/principal";

export const principal = (userId: string): Principal => ({
  userId,
  sessionId: `session-${userId}`,
  expiresAt: Date.now() + 60_000,
});

export async function room() {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({
    serverId: id,
    name: "Socket room",
    ownerId: "alice",
  });
  return { id, owner };
}

export async function socket(
  owner: ReturnType<typeof env.SERVER_DO.getByName>,
  channelId: string,
  userId = "alice",
) {
  return nativeSocket(owner, channelId, principal(userId));
}

export async function barrier(stream: Awaited<ReturnType<typeof socket>>) {
  stream.client.send('{"type":"reconcile"}');
  expect((await stream.next()).type).toBe("reconcile");
}
