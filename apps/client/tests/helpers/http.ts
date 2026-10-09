import { ORPCError } from "@orpc/client";
import { apiErrors, type ApiErrorCode } from "@vaskel/contracts/api";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { ApiError } from "@/client/api/errors";

export const resourcePath = (owner: OwnerScope) =>
  `/api/resources/${owner.kind}/${encodeURIComponent(owner.id)}`;

/** Select a success case in low-level transport fixtures. */
export function assertKind<T extends { kind: string }, K extends T["kind"]>(
  value: T,
  kind: K,
): Extract<T, { kind: K }> {
  if (value.kind !== kind) throw new ApiError(value.kind);
  return value as Extract<T, { kind: K }>;
}

/** Native HTTP failure fixture; overrides can deliberately contradict its envelope. */
export function failureResponse<
  T extends { kind: string } | { status: string },
>(outcome: T, init: ResponseInit = {}) {
  const code = (
    "kind" in outcome ? outcome.kind : outcome.status
  ).toUpperCase() as ApiErrorCode;
  const definition = apiErrors[code];
  if (!definition) throw new Error(`Unknown failure fixture: ${code}`);
  const error = new ORPCError(code, {
    defined: true,
    status: definition.status,
    data: "data" in definition ? outcome : undefined,
  });
  return Response.json(error.toJSON(), { status: definition.status, ...init });
}

export function fetchRequest(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof input === "string" && input.startsWith("/"))
    return new Request(`https://vaskel.test${input}`, init);
  return new Request(input instanceof Request ? input.clone() : input, init);
}
