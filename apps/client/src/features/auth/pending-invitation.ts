/**
 * The invitation this browser registered through, kept until that account
 * joins. Verification links open in a new tab, so signing in there continues
 * to Join instead of an empty Home. A per-device convenience, never account
 * state: without storage the person opens the invitation link again.
 */
interface PendingInvitation {
  token: string;
  /** Lowercased, as the account's own address is. */
  email: string;
  expiresAt: number;
}
const invitationKey = "vaskel.invitation";

function stored(): Partial<PendingInvitation> | null {
  const value: unknown = JSON.parse(
    localStorage.getItem(invitationKey) ?? "null",
  );
  return typeof value === "object"
    ? (value as Partial<PendingInvitation>)
    : null;
}

export function rememberInvitation(invitation: PendingInvitation) {
  try {
    localStorage.setItem(invitationKey, JSON.stringify(invitation));
  } catch {
    /* Private windows may refuse storage; sign-in then lands on Home. */
  }
}

/** The token of this account's invitation while it can still be joined. */
export function pendingInvitation(email: string, now = Date.now()) {
  try {
    const invitation = stored();
    return typeof invitation?.token === "string" &&
      invitation.email === email.toLowerCase() &&
      typeof invitation.expiresAt === "number" &&
      invitation.expiresAt > now
      ? invitation.token
      : null;
  } catch {
    return null;
  }
}

/** Joined or refused: a different invitation registered since stays. */
export function forgetInvitation(token: string) {
  try {
    if (stored()?.token === token) localStorage.removeItem(invitationKey);
  } catch {
    /* Storage that cannot be read holds nothing to forget. */
  }
}
