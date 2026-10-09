-- Private attachment lifecycle, accounting and incident records.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  reservation_expires_at INTEGER NOT NULL,
  filename TEXT,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  object_key TEXT UNIQUE,
  owner_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','uploading','ready','claimed','retired','cleaned')),
  deadline INTEGER,
  object_version TEXT,
  object_etag TEXT,
  writer_state TEXT NOT NULL DEFAULT 'never_started' CHECK(writer_state IN ('never_started','unresolved','settled')),
  message_id TEXT REFERENCES messages(id),
  ordinal INTEGER,
  outstanding INTEGER NOT NULL DEFAULT 1 CHECK(outstanding IN (0,1)),
  quarantined INTEGER NOT NULL DEFAULT 0,
  preservation_hold INTEGER NOT NULL DEFAULT 0,
  cleanup_at INTEGER,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_lease TEXT,
  cleanup_lease_expires_at INTEGER,
  deletion_authorized INTEGER NOT NULL DEFAULT 0,
  cleanup_error TEXT,
  CHECK(state NOT IN ('ready','claimed') OR writer_state = 'settled'),
  CHECK((message_id IS NULL) = (ordinal IS NULL)),
  CHECK(state != 'claimed' OR message_id IS NOT NULL),
  CHECK(state NOT IN ('reserved','uploading','ready') OR outstanding = 1),
  CHECK(state NOT IN ('claimed','cleaned') OR outstanding = 0),
  CHECK(message_id IS NULL OR outstanding = 0),
  CHECK((cleanup_lease IS NULL) = (cleanup_lease_expires_at IS NULL)),
  UNIQUE(uploader_id, command_id),
  UNIQUE(message_id, ordinal)
) STRICT;

CREATE INDEX attachments_deadline ON attachments(deadline) WHERE deadline IS NOT NULL;

CREATE INDEX attachments_cleanup ON attachments(cleanup_at) WHERE cleanup_at IS NOT NULL;

CREATE INDEX attachments_claims ON attachments(message_id) WHERE message_id IS NOT NULL;

CREATE INDEX attachments_outstanding ON attachments(uploader_id) WHERE outstanding = 1;

CREATE TABLE attachment_incidents (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  quarantined INTEGER NOT NULL,
  preservation_hold INTEGER NOT NULL,
  incident_reference TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
