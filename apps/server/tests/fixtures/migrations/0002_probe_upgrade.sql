ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE INDEX messages_by_author ON messages(author_id, sequence);
