/// <reference lib="esnext.float16" />
import { oc } from "@orpc/contract";
import { z } from "zod";
import { errorsFor, messagingErrors } from "./errors";

export type ApiAuthority =
  | "public"
  | "identity"
  | "cleanup"
  | "account"
  | "resource"
  | "message"
  | "capability"
  | "self-service"
  | "media";
export interface ApiMeta {
  authority?: ApiAuthority;
  freshness?: "account" | "search";
}
export const operation = oc
  .$meta<ApiMeta>({
    authority: "account",
    freshness: "account",
  })
  .errors(
    errorsFor(
      "BAD_REQUEST",
      "INVALID_INPUT",
      "INTERNAL_SERVER_ERROR",
      "UNAVAILABLE",
      "PAYLOAD_TOO_LARGE",
      "ORIGIN_REJECTED",
    ),
  );
export const publicOperation = operation.meta({ authority: "public" });
export const sessionSecurity = [
  { sessionCookie: [] },
  { secureSessionCookie: [] },
];
export const account = operation
  .errors(errorsFor("UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CAPACITY"))
  .route({ spec: (spec) => ({ ...spec, security: sessionSecurity }) })
  .meta({ authority: "account" });
export const resource = account
  .errors(messagingErrors)
  .meta({ authority: "resource" });
export const capability = resource.meta({ authority: "capability" });
export const empty = z.object({}).optional();
export const serverParams = z.object({ id: z.uuid() });
export const afterQuery = z.object({ after: z.uuid().optional() });
