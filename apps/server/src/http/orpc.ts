import { ORPCError } from "@orpc/server";
import { apiErrors, type ApiErrorCode } from "@vaskel/contracts/api";

/** Translate once, after the owning transaction has produced its expected result. */
export function outcomeError(result: { kind?: string; status?: string }) {
  const code = (
    result.kind ??
    result.status ??
    ""
  ).toUpperCase() as ApiErrorCode;
  if (!Object.hasOwn(apiErrors, code))
    throw new Error("Unexpected operation outcome");
  const definition = apiErrors[code];
  const data = "data" in definition ? definition.data.parse(result) : undefined;
  return new ORPCError(code, {
    defined: true,
    status: definition.status,
    data,
  });
}
export function expectedOutcome<
  T extends { kind: string },
  K extends T["kind"],
>(result: T, ...expected: K[]): Extract<T, { kind: K }> {
  if (expected.includes(result.kind as K))
    return result as Extract<T, { kind: K }>;
  return failOutcome(result);
}
export function expectedIdentity<
  T extends { status: string },
  K extends T["status"],
>(result: T, ...expected: K[]): Extract<T, { status: K }> {
  if (expected.includes(result.status as K))
    return result as Extract<T, { status: K }>;
  return failOutcome(result);
}

export function failOutcome(result: { kind?: string; status?: string }): never {
  throw outcomeError(result);
}
export function outcomeResponse(result: { kind?: string; status?: string }) {
  const error = outcomeError(result);
  return Response.json(error.toJSON(), {
    status: error.status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
