-- Direct-message participants, block intent and retry receipts.
CREATE TABLE direct_pair (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  conversation_id TEXT NOT NULL UNIQUE,
  first_user_id TEXT NOT NULL,
  second_user_id TEXT NOT NULL,
  CHECK(first_user_id < second_user_id)
) STRICT;

CREATE TABLE direct_blocks (
  user_id TEXT PRIMARY KEY,
  blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision > 0)
) STRICT;

CREATE TABLE block_receipts (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, command_id)
) STRICT;

CREATE INDEX block_receipts_retention ON block_receipts(accepted_at);
