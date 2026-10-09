import type { MemberRole } from "@vaskel/contracts/resources";
import { message, type UiMessage } from "@/client/features/i18n/messages";

/** Room order, roles and invitation state, decided without a network. */

/** The owner leads the list, then the moderators, then everyone else. */
export const roleOrder: Record<MemberRole, number> = {
  owner: 0,
  moderator: 1,
  member: 2,
};

/** The label a role carries in the people list and in circle settings. */
export function roleMessage(role: MemberRole): UiMessage {
  return role === "owner"
    ? message("workspace.ownerRole")
    : role === "moderator"
      ? message("workspace.moderatorRole")
      : message("workspace.memberRole");
}

/** Move one entry to another slot; an out-of-range move keeps the order. */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= next.length ||
    to >= next.length
  )
    return next;
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export interface InviteFacts {
  revoked: boolean;
  uses: number;
  maxUses: number;
  expiresAt: number;
}
export type InviteState = "revoked" | "usedUp" | "expired" | "active";

/**
 * Why an invitation no longer admits anyone. Revocation is a decision, so it
 * outranks a spent invitation, which in turn outranks one that merely ran out
 * of time; an invitation expiring exactly now is already closed.
 */
export function inviteState(invite: InviteFacts, now: number): InviteState {
  if (invite.revoked) return "revoked";
  if (invite.uses >= invite.maxUses) return "usedUp";
  if (invite.expiresAt <= now) return "expired";
  return "active";
}
