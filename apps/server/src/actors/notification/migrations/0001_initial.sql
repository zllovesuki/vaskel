CREATE TABLE notification_account (
  id INTEGER PRIMARY KEY CHECK(id=1),
  account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  preferences_json TEXT NOT NULL,
  vapid_json TEXT NOT NULL
) STRICT;
CREATE TABLE notification_devices (
  device_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  version INTEGER NOT NULL,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE notification_rooms (
  room_key TEXT PRIMARY KEY,
  preference_json TEXT NOT NULL
) STRICT;
CREATE TABLE notification_commands (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_commands_retention ON notification_commands(accepted_at);
CREATE TABLE notification_pending (
  room_key TEXT PRIMARY KEY,
  references_json TEXT NOT NULL,
  due_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_pending_due ON notification_pending(due_at);
CREATE TABLE notification_spacing (
  room_key TEXT PRIMARY KEY,
  next_dispatch_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_spacing_expiry ON notification_spacing(next_dispatch_at);
