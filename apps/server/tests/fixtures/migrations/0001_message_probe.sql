-- This fixture proves storage primitives; it is not a launch message schema.
CREATE TABLE owner_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_water INTEGER NOT NULL CHECK (high_water >= 0),
  search_policy TEXT NOT NULL
) STRICT;
INSERT INTO owner_state (id, high_water, search_policy) VALUES (1, 0, 'native-trigram-v1');

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE
) STRICT;

-- Same contentless configuration as the production message owners.
CREATE VIRTUAL TABLE message_fts USING fts5(message_id UNINDEXED, body, content = '', contentless_delete = 1, contentless_unindexed = 1, tokenize = 'trigram');

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id)
) STRICT;

CREATE TABLE command_receipts (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'send'),
  command_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  sequence INTEGER NOT NULL,
  PRIMARY KEY (actor_id, operation, command_id)
) STRICT;
