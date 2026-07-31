CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  plaid_item_id TEXT NOT NULL UNIQUE,
  institution_id TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  sync_cursor TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
