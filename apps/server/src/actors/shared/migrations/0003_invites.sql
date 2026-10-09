-- Invitation use and account-registration reservations.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX invites_active ON invites(revoked, expires_at);

CREATE TABLE invite_joins (
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(token_hash, user_id)
) STRICT;

CREATE TABLE registration_authorizations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX registration_reservations ON registration_authorizations(token_hash, expires_at, redeemed);

CREATE INDEX registration_authorizations_retention ON registration_authorizations(created_at);
