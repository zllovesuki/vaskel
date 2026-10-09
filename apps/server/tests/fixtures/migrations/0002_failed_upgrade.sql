ALTER TABLE messages ADD COLUMN rejected_revision INTEGER NOT NULL DEFAULT 1;
CREATE VIRTUAL TABLE rejected_fts USING fts5(body, tokenize='trigram');
INSERT INTO rejected_fts (body) VALUES ('must disappear with failed migration');
UPDATE messages SET body = 'must roll back';
INSERT INTO table_that_does_not_exist (value) VALUES (1);
