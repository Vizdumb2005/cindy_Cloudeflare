-- Cindy Brain — D1 schema for the memory (RAG) catalog.
-- Apply with: npx wrangler d1 execute cindy_memory --file=./schema.d1.sql

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,          -- doubles as the Vectorize vector id
  kind TEXT NOT NULL,           -- episodic | semantic | procedural | artifact | working
  source TEXT,                  -- e.g. "session:<id>", "task:<id>", "r2:<key>"
  session_id TEXT,
  task_id TEXT,
  cycle_id TEXT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  r2_key TEXT,                  -- optional R2 pointer for re-ingestion
  token_count INTEGER,
  content_hash TEXT NOT NULL,
  deleted INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_kind_ts ON chunks(kind, ts);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_dedupe ON chunks(source, content_hash);

CREATE TABLE IF NOT EXISTS artifacts (
  r2_key TEXT PRIMARY KEY,
  kind TEXT,
  size INTEGER,
  sha256 TEXT,
  uploaded_at INTEGER,
  cycle_id TEXT,
  ingested INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  source TEXT,
  status TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  payload TEXT,
  reason TEXT,
  retried INTEGER DEFAULT 0
);

-- Meta table: records which D1 migrations have been applied.
CREATE TABLE IF NOT EXISTS d1_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO d1_migrations(name, applied_at) VALUES ('001_init', unixepoch());
