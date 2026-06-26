CREATE TABLE IF NOT EXISTS conversations (
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  title TEXT,
  url TEXT,
  model TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_synced_at TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (provider, id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  parent_id TEXT,
  node_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT,
  PRIMARY KEY (provider, conversation_id, id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(provider, conversation_id, role, content);

CREATE INDEX IF NOT EXISTS idx_conversations_provider_updated
ON conversations(provider, updated_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(provider, conversation_id);

DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, provider, conversation_id, role, content)
  VALUES (new.rowid, new.provider, new.conversation_id, new.role, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, provider, conversation_id, role, content)
  VALUES (new.rowid, new.provider, new.conversation_id, new.role, new.content);
END;
