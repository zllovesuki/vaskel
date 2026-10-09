-- One account generation, its participation and latest accepted command.
-- Participation variants are validated by the owning actor's executable schema.
CREATE TABLE account_media (
  id INTEGER PRIMARY KEY CHECK(id=1),
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  participation TEXT NOT NULL CHECK(json_valid(participation)),
  receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt))
) STRICT;
