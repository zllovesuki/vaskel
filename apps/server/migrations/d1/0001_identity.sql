-- Accounts, credentials, sessions and presentation preferences.
-- Better Auth 1.7.5 core schema. D1 owns identity only, never canonical messages.
CREATE TABLE identity_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  emailVerified INTEGER NOT NULL DEFAULT 0 CHECK (emailVerified IN (0, 1)),
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  authEpoch INTEGER NOT NULL DEFAULT 0 CHECK (authEpoch >= 0)
) STRICT;

CREATE TABLE identity_session (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  authEpoch INTEGER NOT NULL DEFAULT 0 CHECK (authEpoch >= 0)
) STRICT;

CREATE INDEX identity_session_user ON identity_session(userId);

CREATE TABLE identity_account (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(providerId, accountId)
) STRICT;

CREATE INDEX identity_account_user ON identity_account(userId);

-- vaskel. never writes verification rows (identity_token holds its hashed tokens),
-- but the library's runtime schema check requires every core model table.
CREATE TABLE identity_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
) STRICT;

CREATE INDEX identity_verification_identifier ON identity_verification(identifier);

-- Application-owned presentation preferences; absence preserves browser display fallback.
CREATE TABLE identity_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('en', 'zh-Hans', 'zh-Hant', 'ja')),
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;
