import type { QueryClient } from "@tanstack/react-query";
import type { SetBlock } from "@vaskel/contracts/blocking";
import { blockKey, blockStatusOptions, updateBlock } from "@/client/api/blocks";

/** Publish only an owner-confirmed status into this account's cache. */
export async function commitBlock(
  client: QueryClient,
  userId: string,
  targetId: string,
  command: SetBlock,
  signal: AbortSignal,
) {
  const result = await updateBlock(targetId, command, signal);
  signal.throwIfAborted();
  // A read started before the owner commit must not replace the confirmed state.
  await client.cancelQueries({ queryKey: blockKey(userId) });
  signal.throwIfAborted();
  client.setQueryData(
    blockStatusOptions(userId, targetId).queryKey,
    (current) =>
      current && current.revision > result.status.revision
        ? current
        : result.status,
  );
  await client.invalidateQueries({ queryKey: blockKey(userId) });
  signal.throwIfAborted();
  return result.status;
}
