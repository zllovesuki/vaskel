-- Bootstrap, registration, verification and password recovery.
-- Singleton claim and all bootstrap account writes commit in one native D1 batch.
CREATE TABLE identity_operator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  user_id TEXT NOT NULL UNIQUE REFERENCES identity_user(id) DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE identity_registration (
  authorization_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES identity_user(id) DEFERRABLE INITIALLY DEFERRED,
  email TEXT NOT NULL COLLATE NOCASE,
  payload_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE identity_token (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumption_id TEXT UNIQUE
) STRICT;

CREATE INDEX identity_token_user ON identity_token(user_id, kind);

-- Bound cron cleanup without cascading through unsettled delivery leases.
CREATE INDEX identity_token_retention ON identity_token(expires_at, token_hash);

CREATE TABLE identity_mail (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL REFERENCES identity_token(token_hash) ON DELETE CASCADE,
  payload_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at INTEGER,
  delivered_at INTEGER,
  cancelled_at INTEGER
) STRICT;

CREATE INDEX identity_mail_due ON identity_mail(delivered_at, next_attempt_at);

CREATE INDEX identity_mail_token ON identity_mail(token_hash);

CREATE INDEX identity_mail_terminal_retention ON identity_mail(COALESCE(delivered_at, cancelled_at), id)
  WHERE (delivered_at IS NOT NULL OR cancelled_at IS NOT NULL)
    AND lease_id IS NULL AND lease_expires_at IS NULL;

CREATE TABLE identity_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES identity_user(id),
  target_user_id TEXT NOT NULL REFERENCES identity_user(id),
  action TEXT NOT NULL CHECK (action IN ('operator_password_reset_requested')),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
