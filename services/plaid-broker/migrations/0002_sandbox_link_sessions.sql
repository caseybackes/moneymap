-- Sandbox Link is isolated from production connections. A one-time session and
-- per-connection secret prevent a connection ID alone from authorizing sync.
CREATE TABLE IF NOT EXISTS sandbox_link_sessions (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE connections ADD COLUMN owner_secret_hash TEXT;
