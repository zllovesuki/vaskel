import { expect } from "vitest";
import { ORPCError, validateORPCError } from "@orpc/server";
import { apiErrors } from "@vaskel/contracts/api";

/** Assert the native HTTP envelope and validate its declared recovery payload. */
export async function readHttpFailure(response: Response) {
  expect(response.ok).toBe(false);
  const value = (await response.json()) as {
    code: string;
    status: number;
    defined: boolean;
    message: string;
    data?: unknown;
  };
  expect(value.status).toBe(response.status);
  expect(value.code).toBeTypeOf("string");
  expect(value.defined).toBeTypeOf("boolean");
  const error = await validateORPCError(
    apiErrors,
    new ORPCError(value.code, {
      defined: value.defined,
      status: value.status,
      data: value.data,
      message: value.message,
    }),
  );
  expect(
    error.defined,
    `${value.code} must match its declared status and recovery data`,
  ).toBe(true);
  return error;
}
