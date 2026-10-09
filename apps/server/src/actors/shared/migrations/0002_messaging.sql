-- Messages, search, reactions, mentions, replay and command recovery.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT,
  version INTEGER NOT NULL,
  created_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  quote_json TEXT
) STRICT;

CREATE INDEX messages_history ON messages(channel_id, created_sequence DESC);

-- Unread counts skip tombstones and filter by author. Keep messages_history
-- for snapshots and creation positions, which also include tombstones.
CREATE INDEX messages_live_history
ON messages(channel_id, created_sequence DESC, author_id)
WHERE deleted_at IS NULL;

CREATE TABLE deleted_payloads (
  message_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  eligible_at INTEGER NOT NULL,
  quote_json TEXT
) STRICT;

CREATE INDEX deleted_payloads_gc ON deleted_payloads(eligible_at);

CREATE VIRTUAL TABLE message_fts USING fts5(
  message_id UNINDEXED,
  body,
  content = '',
  contentless_delete = 1,
  contentless_unindexed = 1,
  tokenize = 'trigram'
);

CREATE TABLE reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji)
) STRICT;

CREATE TABLE mentions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_sequence INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id)
) STRICT;

CREATE INDEX mentions_unread ON mentions(user_id, channel_id, created_sequence);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  message_id TEXT NOT NULL,
  previous_sequence INTEGER
) STRICT;

CREATE INDEX events_channel ON events(channel_id, sequence);

CREATE TABLE channel_progress (
  channel_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL
) STRICT;

CREATE TABLE command_receipts (
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  version INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, operation, command_id)
) STRICT;

CREATE INDEX receipts_retention ON command_receipts(accepted_at);

CREATE TABLE read_cursors (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY(user_id, channel_id)
) STRICT;
