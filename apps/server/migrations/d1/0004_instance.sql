-- Instance administration, creation grants and presentation settings.
CREATE TABLE instance_capability (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES identity_user(id),
  create_servers INTEGER NOT NULL CHECK (create_servers IN (0, 1)),
  granted_by TEXT NOT NULL REFERENCES identity_user(id),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE directory_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES identity_user(id),
  target_id TEXT NOT NULL REFERENCES identity_user(id),
  action TEXT NOT NULL CHECK (action = 'server_creation_permission'),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE instance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  icon_key TEXT,
  icon_type TEXT CHECK (icon_type IN ('image/png', 'image/jpeg', 'image/webp')),
  invite_policy TEXT NOT NULL CHECK (invite_policy IN ('members', 'owners')),
  updated_at INTEGER NOT NULL,
  icon_cleanup_cursor TEXT
) STRICT;

INSERT INTO instance_settings(id, name, invite_policy, updated_at) VALUES (1, 'vaskel.', 'members', 0);
