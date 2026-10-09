-- Owner identity, initialization, rooms and membership authority.
CREATE TABLE owner_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  generation TEXT NOT NULL,
  high_water INTEGER NOT NULL DEFAULT 0,
  replay_floor INTEGER NOT NULL DEFAULT 0,
  search_policy TEXT NOT NULL DEFAULT 'native-trigram-v1',
  attachment_bytes INTEGER NOT NULL DEFAULT 0 CHECK(attachment_bytes >= 0),
  members_may_invite INTEGER NOT NULL DEFAULT 1 CHECK(members_may_invite IN (0, 1)),
  -- Advances only for permission-affecting mutations; version also counts metadata edits.
  permission_version INTEGER NOT NULL DEFAULT 1 CHECK(permission_version >= 1)
) STRICT;

CREATE TABLE server_initialization (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  first_channel_name TEXT NOT NULL
) STRICT;

CREATE TABLE "members" (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('owner', 'moderator', 'member'))
) STRICT;

CREATE UNIQUE INDEX members_single_owner ON members(role) WHERE role = 'owner';

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  private INTEGER NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'media')),
  topic TEXT,
  position INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(channel_id, user_id)
) STRICT;
