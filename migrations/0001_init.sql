CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  owner_uuid TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  block_count INTEGER NOT NULL,
  region_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS items_public_created ON items(deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS items_owner_created ON items(owner_uuid, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS items_owner_hash_active ON items(owner_uuid, hash) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions(expires_at);
