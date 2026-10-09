-- Account-qualified security fences and transition-only disconnect state.
CREATE TABLE dispatch_accounts (
  user_id TEXT PRIMARY KEY,
  minimum_auth_epoch INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0
) STRICT;


CREATE TABLE dispatch_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX dispatch_ticket_account ON dispatch_tickets(user_id);
CREATE INDEX dispatch_ticket_expiry ON dispatch_tickets(expires_at);

CREATE TABLE dispatch_revoked_sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
) STRICT;

CREATE INDEX dispatch_revocation_expiry ON dispatch_revoked_sessions(expires_at);
