import { zValidator } from "@hono/zod-validator";
import type { Env, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { failOutcome } from "./orpc";

/** The raw SSE endpoint uses Hono's byte limit and retains its native stream. */
export function applicationJson<Output, Input>(
  schema: z.ZodType<Output, Input>,
): MiddlewareHandler<
  Env,
  string,
  { in: { json: Input }; out: { json: Output } }
> {
  return async (context, next) => {
    let input: unknown;
    if (
      context.req
        .header("Content-Type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() === "application/json"
    ) {
      try {
        input = await context.req.raw.json();
      } catch {
        /* The validator returns a typed input failure. */
      }
    }
    context.req.bodyCache.json = Promise.resolve(input);
    return zValidator(
      "json",
      schema,
      (result) => {
        if (!result.success) failOutcome({ kind: "invalid_input" });
      },
      { validationFunction: (selected) => selected.safeParseAsync(input) },
    )(context, next);
  };
}
