-- Plaid transaction history is prepared asynchronously. Persist the provider's
-- readiness state and a short sync lease so startup/manual refreshes cannot race.
ALTER TABLE connections ADD COLUMN transactions_update_status TEXT NOT NULL DEFAULT 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN';
ALTER TABLE connections ADD COLUMN sync_operation_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE connections ADD COLUMN sync_started_at INTEGER;
ALTER TABLE connections ADD COLUMN last_transaction_sync_at INTEGER;
ALTER TABLE connections ADD COLUMN last_sync_error TEXT;
