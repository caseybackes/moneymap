-- Retain completed Link authority until the session expires so a desktop retry
-- after a lost response receives the same connection instead of creating a
-- second Plaid Item. The recoverable connection secret remains encrypted.
ALTER TABLE sandbox_link_sessions ADD COLUMN completion_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE sandbox_link_sessions ADD COLUMN completion_started_at INTEGER;
ALTER TABLE sandbox_link_sessions ADD COLUMN completed_connection_id TEXT;
ALTER TABLE sandbox_link_sessions ADD COLUMN completed_secret_ciphertext TEXT;
ALTER TABLE sandbox_link_sessions ADD COLUMN completed_secret_iv TEXT;
ALTER TABLE sandbox_link_sessions ADD COLUMN completed_institution_name TEXT;
