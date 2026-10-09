-- Test-only identity/directory data; no message mirror or production auth schema.
CREATE TABLE probe_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE probe_directory (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES probe_accounts(id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending', 'ready'))
) STRICT;
