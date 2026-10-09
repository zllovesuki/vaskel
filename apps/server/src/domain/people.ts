import type { MessagingFailure } from "@vaskel/contracts/messaging";

export const PEOPLE_CANDIDATE_LIMIT = 200;
export type SharedPeopleOutcome =
  MessagingFailure | { kind: "shared_people"; userIds: string[] };
