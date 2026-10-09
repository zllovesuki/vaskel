import { type ChangePasswordRequest } from "@vaskel/contracts/account";
import { api } from "@/client/api/contract";
import { queryOptions } from "@tanstack/react-query";

import { privateKey } from "@/client/api/client";

/** Account self-service keeps the identity router's origin and cache guards. */

export const sessionsKey = (userId: string) =>
  [...privateKey(userId), "sessions"] as const;

export function sessionsOptions(userId: string) {
  return queryOptions({
    queryKey: sessionsKey(userId),
    queryFn: ({ signal }) => api.sessions(undefined, { signal: signal }),
    retry: false,
  });
}

export function updateProfile(name: string) {
  return api.profile({
    body: {
      name,
    },
  });
}

/** The password change keeps this session; other devices go only on request. */
export function changePassword(input: ChangePasswordRequest) {
  return api.changePassword({ body: input });
}

export function revokeSession(sessionId: string) {
  return api.revokeSession({
    body: {
      sessionId,
    },
  });
}
