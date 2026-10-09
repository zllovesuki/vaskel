/** Session authority also retained by a read-only WebSocket lease. */
export interface SessionAssertion {
  userId: string;
  sessionId: string;
  expiresAt: number;
}

/** Trusted Worker context. Only authenticated ingress constructs this RPC argument. */
export type Principal = SessionAssertion;

/** Fresh primary D1 invite policy, supplied only by authenticated Worker ingress. */
export type InvitePrincipal = Principal & {
  invitePolicy: import("@vaskel/contracts/instance").InvitePolicy;
};
