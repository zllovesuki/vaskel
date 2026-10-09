-- Room membership, permission fences, moderation and occupancy delivery.
CREATE TABLE media_room (
  id INTEGER PRIMARY KEY CHECK(id=1),
  room TEXT NOT NULL,
  revision INTEGER NOT NULL
) STRICT;

CREATE TABLE media_participants (
  id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_expires INTEGER NOT NULL,
  permission_generation INTEGER NOT NULL,
  control_version INTEGER NOT NULL DEFAULT 0 CHECK(control_version >= 0),
  muted INTEGER NOT NULL DEFAULT 0,
  deafened INTEGER NOT NULL DEFAULT 0,
  screen_revoked INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  cancellation_pending INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_pending IN (0,1)),
  closed_at INTEGER,
  cleanup_at INTEGER,
  PRIMARY KEY(id,generation)
) STRICT;

CREATE INDEX media_participant_cleanup ON media_participants(cleanup_at,id,generation)
  WHERE cleanup_at IS NOT NULL;

CREATE INDEX media_participant_status ON media_participants(status,lease_expires);

CREATE INDEX media_participant_retention ON media_participants(closed_at)
  WHERE status='left' AND cancellation_pending=0;

CREATE INDEX media_participant_generation ON media_participants(user_id, generation);

CREATE TABLE media_permission_floors (
  user_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
) STRICT;

CREATE TABLE media_restrictions (
  user_id TEXT PRIMARY KEY,
  muted INTEGER NOT NULL,
  deafened INTEGER NOT NULL,
  screen_revoked INTEGER NOT NULL
) STRICT;

CREATE TABLE media_moderation_receipts (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,command_id)
) STRICT;

CREATE INDEX media_moderation_retention ON media_moderation_receipts(created_at);

CREATE TABLE media_occupancy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  next_attempt_at INTEGER,
  lease_id TEXT,
  lease_expires_at INTEGER
) STRICT;
