import { errorsFor } from "./errors";
import { z } from "zod";
import { account, afterQuery } from "./base";
import { outcome } from "./outcome";
import {
  CreateConversationRequestSchema,
  CreateServerRequestSchema,
  PeopleResponseSchema,
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "../directory";
export const PeopleQuerySchema = z.object({
  ids: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.uuid()).min(1).max(40))
    .optional(),
  query: z.string().trim().max(80).default(""),
});
const creation = account.errors(
  errorsFor("COMMAND_CONFLICT", "STORAGE_CAPACITY", "INSTANCE_CAPACITY"),
);
export const directoryApiContract = {
  directory: account
    .route({ method: "GET", path: "/directory", inputStructure: "detailed" })
    .input(z.object({ query: afterQuery }))
    .output(outcome(ResourceDirectorySchema, "directory")),
  people: account
    .route({ method: "GET", path: "/people", inputStructure: "detailed" })
    .input(z.object({ query: PeopleQuerySchema }))
    .output(outcome(PeopleResponseSchema, "people")),
  createServer: creation
    .route({
      method: "POST",
      path: "/servers",
      inputStructure: "detailed",
      successStatus: 201,
    })
    .input(z.object({ body: CreateServerRequestSchema }))
    .output(outcome(ResourceCreatedSchema, "created")),
  createConversation: creation
    .route({
      method: "POST",
      path: "/conversations",
      inputStructure: "detailed",
      successStatus: 201,
    })
    .input(z.object({ body: CreateConversationRequestSchema }))
    .output(outcome(ResourceCreatedSchema, "created")),
};
