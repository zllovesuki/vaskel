import { applicationRead, applicationPrimary } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { directoryDatabase } from "@/server/directory/database";
import { searchPeople } from "@/server/directory/people";
import {
  createConversation,
  createServer,
  listResources,
} from "@/server/directory/resources";

export const directoryProcedures = {
  directory: applicationRead.directory.handler(async ({ context, input }) =>
    expectedOutcome(
      await listResources(
        context.env,
        context.principal,
        input.query.after,
        context.directorySession,
      ),
      "directory",
    ),
  ),
  createServer: applicationPrimary.createServer.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await createServer(
          context.env,
          context.principal,
          input.body,
          context.directorySession,
        ),
        "created",
      ),
  ),
  createConversation: applicationPrimary.createConversation.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await createConversation(
          context.env,
          context.principal,
          input.body.userId,
          context.directorySession,
        ),
        "created",
      ),
  ),
  people: applicationRead.people.handler(async ({ context, input }) => {
    const { ids, query } = input.query;
    if (ids) {
      const people = await directoryDatabase(
        context.env,
        context.directorySession,
      )
        .selectFrom("identity_user")
        .select(["id as userId", "name as displayName"])
        .where("emailVerified", "=", 1)
        .where("id", "in", ids)
        .orderBy("name")
        .orderBy("id")
        .limit(40)
        .execute();
      return { kind: "people" as const, people, partial: false };
    }
    return expectedOutcome(
      await searchPeople(
        context.env,
        context.principal,
        query,
        context.directorySession,
      ),
      "people",
    );
  }),
};
