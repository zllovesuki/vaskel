-- Discovery and creation coordination; authority stays with each actor.
-- Navigation and creation coordination only. Canonical membership and messages stay in their actor.
CREATE TABLE resource_directory (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('server', 'conversation')),
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES identity_user(id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending', 'ready')),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Pending creation receipts and ready owners both consume an instance slot.
-- Count the source of truth instead of maintaining a separately recoverable counter.
CREATE INDEX resource_directory_by_kind ON resource_directory(kind);

CREATE TABLE resource_membership_index (
  resource_id TEXT NOT NULL REFERENCES resource_directory(id),
  user_id TEXT NOT NULL REFERENCES identity_user(id),
  PRIMARY KEY (resource_id, user_id)
) STRICT;

CREATE INDEX resource_membership_by_user ON resource_membership_index(user_id, resource_id);

-- Discovery references only. No block intent or authoritative rule lives in D1.
-- Retained after unblock; no resource_directory FK because a DM may not exist yet.
CREATE TABLE block_candidates (
  user_id TEXT NOT NULL REFERENCES identity_user(id),
  target_id TEXT NOT NULL REFERENCES identity_user(id),
  conversation_id TEXT NOT NULL,
  PRIMARY KEY(user_id, target_id),
  CHECK(user_id <> target_id)
) STRICT;
