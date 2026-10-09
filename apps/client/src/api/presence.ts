import type { OwnerScope } from "@vaskel/contracts/messaging";
import { type PresenceScopeRequest } from "@vaskel/contracts/presence";
import { api } from "@/client/api/contract";

import { privateKey } from "./client";

export const presenceKey = (userId: string, owner: OwnerScope) =>
  [...privateKey(userId), "presence", owner.kind, owner.id] as const;

export async function samplePresence(
  scopes: PresenceScopeRequest[],
  signal: AbortSignal,
) {
  return (await api.presence({ body: { scopes } }, { signal: signal })).scopes;
}
