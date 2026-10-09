import { ApiError, type RequestScope } from "@/client/api/client";

export const privateRequest = (scope: RequestScope) =>
  !["public", "identity", "cleanup"].includes(scope.authority);
export const requestOwner = (scope: RequestScope) => scope.owner ?? null;

/** Local refusals describe an action or a single message, not account/room access. */
export function localFailure(scope: RequestScope, error: ApiError) {
  if (
    scope.authority === "self-service" &&
    error.code === "invalid_credentials"
  )
    return true;
  if (scope.authority === "message" && error.status === 404) return true;
  return (
    ["capability", "media"].includes(scope.authority) &&
    (error.status === 403 || error.status === 404)
  );
}
