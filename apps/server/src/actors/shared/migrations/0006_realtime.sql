-- Socket admission, occupancy and durable media revocation.
CREATE TABLE socket_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX socket_tickets_expiry ON socket_tickets(expires_at);

CREATE TABLE channel_occupancy (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id),
  revision INTEGER NOT NULL,
  summary TEXT NOT NULL
) STRICT;

CREATE TABLE media_invalidations (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  permission_generation INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at INTEGER,
  PRIMARY KEY (channel_id, user_id)
) STRICT;

CREATE INDEX media_invalidations_due ON media_invalidations(next_attempt_at);
