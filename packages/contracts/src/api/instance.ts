import { HealthResponseSchema } from "../health";
import { z } from "zod";
import { publicOperation, capability, empty, afterQuery } from "./base";
import { outcome } from "./outcome";
import {
  PublicInstanceSchema,
  OperatorInstanceSchema,
  OperatorAccountsOutcomeSchema,
  OperatorUsageOutcomeSchema,
  UpdateInstanceSchema,
} from "../instance";
import { GrantResponseSchema, ServerCreationGrantSchema } from "../directory";
export const instanceApiContract = {
  health: publicOperation
    .route({ method: "GET", path: "/health" })
    .input(empty)
    .output(HealthResponseSchema),
  instance: publicOperation
    .route({ method: "GET", path: "/instance" })
    .input(empty)
    .output(PublicInstanceSchema),
  operatorInstance: capability
    .route({ method: "GET", path: "/operator/instance" })
    .input(empty)
    .output(OperatorInstanceSchema),
  updateInstance: capability
    .route({
      method: "POST",
      path: "/operator/instance",
      inputStructure: "detailed",
    })
    .input(z.object({ body: UpdateInstanceSchema }))
    .output(OperatorInstanceSchema),
  serverCreationGrant: capability
    .route({
      method: "POST",
      path: "/operator/server-creation",
      inputStructure: "detailed",
    })
    .input(z.object({ body: ServerCreationGrantSchema }))
    .output(outcome(GrantResponseSchema, "granted")),
  operatorAccounts: capability
    .route({
      method: "GET",
      path: "/operator/accounts",
      inputStructure: "detailed",
    })
    .input(z.object({ query: afterQuery }))
    .output(outcome(OperatorAccountsOutcomeSchema, "accounts")),
  operatorUsage: capability
    .route({
      method: "GET",
      path: "/operator/usage",
      inputStructure: "detailed",
    })
    .input(z.object({ query: afterQuery }))
    .output(outcome(OperatorUsageOutcomeSchema, "usage")),
};
