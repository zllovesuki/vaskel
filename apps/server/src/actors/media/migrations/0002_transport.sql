-- SFU sessions, negotiation receipts and track allocation/forwarding.
CREATE TABLE media_sessions (
  session_key TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  direction TEXT NOT NULL,
  provider_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL,
  operation_id TEXT,
  deadline INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX media_session_participant ON media_sessions(participant_id, generation);

CREATE TABLE media_operations (
  participant_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  direction TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result TEXT,
  answer_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(participant_id,generation,direction,operation_id)
) STRICT;

CREATE INDEX media_operations_retention ON media_operations(created_at);

CREATE TABLE media_allocations (
  session_key TEXT NOT NULL,
  mid TEXT NOT NULL,
  PRIMARY KEY(session_key,mid)
) STRICT;

CREATE TABLE media_publications (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source TEXT NOT NULL,
  session_key TEXT NOT NULL,
  mid TEXT NOT NULL,
  track_name TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX media_publication_participant ON media_publications(participant_id, generation);

CREATE TABLE media_subscriptions (
  session_key TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  mid TEXT NOT NULL,
  source_session_key TEXT NOT NULL,
  source_transferred INTEGER NOT NULL DEFAULT 0 CHECK(source_transferred IN (0,1)),
  PRIMARY KEY(session_key,publication_id)
) STRICT;

CREATE INDEX media_subscription_source ON media_subscriptions(source_session_key);
