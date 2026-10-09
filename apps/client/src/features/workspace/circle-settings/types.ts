import type { MembersOutcome } from "@vaskel/contracts/resources";
import type { ServerAdministrationOutcome } from "@vaskel/contracts/administration";

export type CircleResource = Extract<
  ServerAdministrationOutcome,
  { kind: "administration" }
>;

export type Room = CircleResource["channels"][number];

type Members = Extract<MembersOutcome, { kind: "members" }>;

/** The people of this circle, and whether the list is settled. */
export interface MemberState {
  data: Members | undefined;
  loading: boolean;
  failed: boolean;
}

/** Their display names, and whether those are settled. */
export interface PeopleState {
  names: Map<string, string>;
  loading: boolean;
  failed: boolean;
}
