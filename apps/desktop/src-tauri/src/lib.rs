use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use keyring::Entry;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.caseybackes.family-finance";
const KEYRING_ACCOUNT: &str = "database-key-v2";
const SANDBOX_BROKER_URL: &str = "https://family-finance-broker.cloud-admin-f91.workers.dev/v1/sandbox/demo-transactions";
const SANDBOX_BROKER_BASE_URL: &str = "https://family-finance-broker.cloud-admin-f91.workers.dev/v1/sandbox";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseStatus {
    database_path: String,
    encrypted: bool,
    schema_version: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardAccount {
    id: String,
    name: String,
    account_type: String,
    balance_cents: i64,
    /// Present only for Plaid-synced accounts. Manual accounts deliberately
    /// continue to use the same dashboard model with these fields absent.
    plaid_connection_id: Option<String>,
    external_account_id: Option<String>,
    plaid_account_type: Option<String>,
    plaid_account_subtype: Option<String>,
    mask: Option<String>,
    current_balance_cents: Option<i64>,
    available_balance_cents: Option<i64>,
    balance_refreshed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardTransaction {
    id: String,
    account_id: String,
    transaction_date: String,
    description: String,
    account_name: String,
    category_name: String,
    category_id: Option<String>,
    amount_cents: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardData {
    income_cents: i64,
    spending_cents: i64,
    accounts: Vec<DashboardAccount>,
    recent_transactions: Vec<DashboardTransaction>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerData {
    transactions: Vec<DashboardTransaction>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledEntry { id: String, account_id: String, start_date: String, end_date: Option<String>, next_occurrence: String, description: String, amount_cents: i64, recurrence: String, account_name: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecurringSuggestion { account_id: String, account_name: String, description: String, amount_cents: i64, recurrence: String, next_occurrence: String, occurrences: i64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaidConnectionInfo { id: String, institution_name: String, environment: String, account_count: i64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SandboxLinkSession {
    link_token: String,
    session_id: String,
    session_secret: String,
    expiration: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteSandboxLinkInput {
    session_id: String,
    session_secret: String,
    public_token: String,
    institution_id: Option<String>,
    institution_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAccountInput {
    name: String,
    account_type: String,
    opening_balance_cents: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTransactionInput {
    account_id: String,
    transaction_date: String,
    description: String,
    amount_cents: i64,
    category_id: Option<String>,
    notes: Option<String>,
    schedule_recurrence: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTransactionInput {
    id: String,
    account_id: String,
    transaction_date: String,
    description: String,
    amount_cents: i64,
    category_id: Option<String>,
    notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoryEntry { id: String, name: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdjustAccountBalanceInput {
    account_id: String,
    target_balance_cents: i64,
    transaction_date: String,
    notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateScheduleInput { account_id: String, start_date: String, end_date: Option<String>, description: String, amount_cents: i64, recurrence: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateScheduleInput { id: String, account_id: String, start_date: String, end_date: Option<String>, description: String, amount_cents: i64, recurrence: String }

fn new_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    STANDARD_NO_PAD.encode(bytes)
}

fn database_key() -> Result<String, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(key) if !key.is_empty() => Ok(key),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let mut bytes = [0_u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let key = STANDARD_NO_PAD.encode(bytes);
            entry.set_password(&key).map_err(|error| error.to_string())?;
            Ok(key)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn database_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("family-finance-v2.db"))
}

fn write_diagnostic(app: &AppHandle, event: &str) {
    let Ok(directory) = app.path().app_local_data_dir() else { return; };
    let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(directory.join("family-finance.log")) else { return; };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown-time".to_string());
    let _ = writeln!(file, "{timestamp} {event}");
}

fn open_database(app: &AppHandle) -> Result<(Connection, String), String> {
    let result = open_database_inner(app);
    match &result {
        Ok((_, path)) => write_diagnostic(app, &format!("database opened path={path}")),
        Err(error) => write_diagnostic(app, &format!("database open failed error={error}")),
    }
    result
}

fn open_database_inner(app: &AppHandle) -> Result<(Connection, String), String> {
    let path = database_path(app)?;
    let key = database_key()?;
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    connection.pragma_update(None, "key", &key).map_err(|error| error.to_string())?;
    connection.execute_batch(
        "PRAGMA cipher_memory_security = ON;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL);
         CREATE TABLE IF NOT EXISTS accounts (
           id TEXT PRIMARY KEY NOT NULL,
           name TEXT NOT NULL,
           type TEXT NOT NULL,
           opening_balance_cents INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS categories (
           id TEXT PRIMARY KEY NOT NULL,
           name TEXT NOT NULL COLLATE NOCASE UNIQUE
         );
         INSERT OR IGNORE INTO categories(id, name) VALUES
           ('category-income', 'Income'), ('category-housing', 'Housing'), ('category-food', 'Food'),
           ('category-transportation', 'Transportation'), ('category-utilities', 'Utilities'), ('category-health', 'Health'),
           ('category-shopping', 'Shopping'), ('category-entertainment', 'Entertainment'), ('category-taxes', 'Taxes'),
           ('category-savings', 'Savings'), ('category-debt', 'Debt'), ('category-transfer', 'Transfer');
         CREATE TABLE IF NOT EXISTS transactions (
           id TEXT PRIMARY KEY NOT NULL,
           account_id TEXT NOT NULL REFERENCES accounts(id),
           transaction_date TEXT NOT NULL,
           description TEXT NOT NULL,
           amount_cents INTEGER NOT NULL,
           category_id TEXT REFERENCES categories(id),
           notes TEXT,
           source TEXT NOT NULL DEFAULT 'manual',
           external_transaction_id TEXT,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           UNIQUE(source, external_transaction_id)
         );
         CREATE TABLE IF NOT EXISTS scheduled_transactions (
           id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), start_date TEXT NOT NULL, end_date TEXT,
           description TEXT NOT NULL, amount_cents INTEGER NOT NULL,
           recurrence TEXT NOT NULL CHECK(recurrence IN ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')), active INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS plaid_connections (
           id TEXT PRIMARY KEY NOT NULL,
           broker_connection_id TEXT NOT NULL UNIQUE,
           connection_secret TEXT NOT NULL,
           institution_name TEXT NOT NULL,
           environment TEXT NOT NULL CHECK(environment IN ('sandbox', 'production')),
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS plaid_account_links (
           plaid_connection_id TEXT NOT NULL REFERENCES plaid_connections(id) ON DELETE CASCADE,
           external_account_id TEXT NOT NULL,
           account_id TEXT NOT NULL REFERENCES accounts(id),
           plaid_account_type TEXT,
           plaid_account_subtype TEXT,
           mask TEXT,
           current_balance_cents INTEGER,
           available_balance_cents INTEGER,
           balance_refreshed_at TEXT,
           PRIMARY KEY(plaid_connection_id, external_account_id)
         );
         INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);"
    ).map_err(|error| error.to_string())?;
    let has_reported_balance: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'reported_balance_cents')",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_reported_balance {
        connection.execute_batch("ALTER TABLE accounts ADD COLUMN reported_balance_cents INTEGER; INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);")
            .map_err(|error| error.to_string())?;
    }
    let has_schedule_progress: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('scheduled_transactions') WHERE name = 'last_processed_occurrence')",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_schedule_progress {
        connection.execute_batch("ALTER TABLE scheduled_transactions ADD COLUMN last_processed_occurrence TEXT; INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);")
            .map_err(|error| error.to_string())?;
    }
    let has_plaid_account_metadata: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('plaid_account_links') WHERE name = 'plaid_account_type')",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_plaid_account_metadata {
        connection.execute_batch(
            "ALTER TABLE plaid_account_links ADD COLUMN plaid_account_type TEXT;
             ALTER TABLE plaid_account_links ADD COLUMN plaid_account_subtype TEXT;
             ALTER TABLE plaid_account_links ADD COLUMN mask TEXT;
             ALTER TABLE plaid_account_links ADD COLUMN current_balance_cents INTEGER;
             ALTER TABLE plaid_account_links ADD COLUMN available_balance_cents INTEGER;
             ALTER TABLE plaid_account_links ADD COLUMN balance_refreshed_at TEXT;"
        ).map_err(|error| error.to_string())?;
    }
    connection.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (4)", [])
        .map_err(|error| error.to_string())?;
    let has_extended_recurrences: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 5)",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_extended_recurrences {
        connection.execute_batch(
            "BEGIN;
             CREATE TABLE scheduled_transactions_recurrence_v5 (
               id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), start_date TEXT NOT NULL,
               description TEXT NOT NULL, amount_cents INTEGER NOT NULL,
               recurrence TEXT NOT NULL CHECK(recurrence IN ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
               active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               last_processed_occurrence TEXT
             );
             INSERT INTO scheduled_transactions_recurrence_v5(id, account_id, start_date, description, amount_cents, recurrence, active, created_at, last_processed_occurrence)
             SELECT id, account_id, start_date, description, amount_cents, recurrence, active, created_at, last_processed_occurrence FROM scheduled_transactions;
             DROP TABLE scheduled_transactions;
             ALTER TABLE scheduled_transactions_recurrence_v5 RENAME TO scheduled_transactions;
             INSERT INTO schema_migrations(version) VALUES (5);
             COMMIT;"
        ).map_err(|error| error.to_string())?;
    }
    let has_schedule_end_date: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('scheduled_transactions') WHERE name = 'end_date')",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_schedule_end_date {
        connection.execute_batch("ALTER TABLE scheduled_transactions ADD COLUMN end_date TEXT;")
            .map_err(|error| error.to_string())?;
    }
    connection.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (6)", [])
        .map_err(|error| error.to_string())?;
    Ok((connection, path.display().to_string()))
}

/// Archives an unreadable local database, clears its unusable key, and creates a
/// fresh encrypted store. The archive is deliberately retained for support or
/// forensic recovery; this command never deletes the prior file.
#[tauri::command]
fn reset_unavailable_database(app: AppHandle) -> Result<DatabaseStatus, String> {
    let path = database_path(&app)?;
    if path.exists() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs();
        let archive = path.with_file_name(format!("family-finance-v2.unreadable-{timestamp}.db"));
        fs::rename(&path, &archive).map_err(|error| format!("Could not preserve the unreadable database: {error}"))?;
    }

    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(error.to_string()),
    }

    let (connection, path) = open_database(&app)?;
    let schema_version: u32 = connection
        .query_row("SELECT max(version) FROM schema_migrations", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(DatabaseStatus { database_path: path, encrypted: true, schema_version })
}

#[tauri::command]
fn database_status(app: AppHandle) -> Result<DatabaseStatus, String> {
    let (connection, path) = open_database(&app)?;
    let schema_version: u32 = connection
        .query_row("SELECT max(version) FROM schema_migrations", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(DatabaseStatus { database_path: path, encrypted: true, schema_version })
}

#[tauri::command]
fn dashboard_data(app: AppHandle) -> Result<DashboardData, String> {
    let (connection, _) = open_database(&app)?;
    let (income_cents, spending_cents) = connection.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN amount_cents > 0 AND transaction_date >= date('now', 'start of month') THEN amount_cents ELSE 0 END), 0),
           COALESCE(-SUM(CASE WHEN amount_cents < 0 AND transaction_date >= date('now', 'start of month') THEN amount_cents ELSE 0 END), 0)
         FROM transactions",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| error.to_string())?;

    let mut account_statement = connection.prepare(
        "SELECT a.id, a.name, a.type, COALESCE(a.reported_balance_cents, a.opening_balance_cents + COALESCE(SUM(t.amount_cents), 0)),
                l.plaid_connection_id, l.external_account_id, l.plaid_account_type, l.plaid_account_subtype, l.mask,
                l.current_balance_cents, l.available_balance_cents, l.balance_refreshed_at
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         LEFT JOIN plaid_account_links l ON l.account_id = a.id
         GROUP BY a.id, a.name, a.type, a.opening_balance_cents, a.reported_balance_cents,
                  l.plaid_connection_id, l.external_account_id, l.plaid_account_type, l.plaid_account_subtype, l.mask,
                  l.current_balance_cents, l.available_balance_cents, l.balance_refreshed_at
         ORDER BY a.name COLLATE NOCASE",
    ).map_err(|error| error.to_string())?;
    let accounts = account_statement.query_map([], |row| Ok(DashboardAccount {
        id: row.get(0)?, name: row.get(1)?, account_type: row.get(2)?, balance_cents: row.get(3)?,
        plaid_connection_id: row.get(4)?, external_account_id: row.get(5)?, plaid_account_type: row.get(6)?,
        plaid_account_subtype: row.get(7)?, mask: row.get(8)?, current_balance_cents: row.get(9)?,
        available_balance_cents: row.get(10)?, balance_refreshed_at: row.get(11)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    let mut transaction_statement = connection.prepare(
        "SELECT t.id, t.account_id, t.transaction_date, t.description, a.name, COALESCE(c.name, 'Uncategorized'), t.category_id, t.amount_cents
         FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
         ORDER BY t.transaction_date DESC, t.created_at DESC",
    ).map_err(|error| error.to_string())?;
    let recent_transactions = transaction_statement.query_map([], |row| Ok(DashboardTransaction {
        id: row.get(0)?, account_id: row.get(1)?, transaction_date: row.get(2)?, description: row.get(3)?, account_name: row.get(4)?, category_name: row.get(5)?, category_id: row.get(6)?, amount_cents: row.get(7)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    Ok(DashboardData { income_cents, spending_cents, accounts, recent_transactions })
}

#[tauri::command]
fn create_account(app: AppHandle, input: CreateAccountInput) -> Result<String, String> {
    let name = input.name.trim();
    if name.is_empty() { return Err("An account name is required.".into()); }
    if input.account_type.trim().is_empty() { return Err("An account type is required.".into()); }
    let (connection, _) = open_database(&app)?;
    let id = new_id();
    connection.execute(
        "INSERT INTO accounts(id, name, type, opening_balance_cents) VALUES (?1, ?2, ?3, ?4)",
        (&id, name, input.account_type.trim(), input.opening_balance_cents),
    ).map_err(|error| error.to_string())?;
    Ok(id)
}

#[tauri::command]
fn create_transaction(app: AppHandle, input: CreateTransactionInput) -> Result<String, String> {
    if input.description.trim().is_empty() { return Err("A transaction description is required.".into()); }
    if !input.transaction_date.chars().all(|character| character.is_ascii_digit() || character == '-') || input.transaction_date.len() != 10 {
        return Err("Transaction date must use YYYY-MM-DD.".into());
    }
    let (connection, _) = open_database(&app)?;
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1)", [&input.account_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !exists { return Err("Choose an existing account.".into()); }
    let id = new_id();
    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO transactions(id, account_id, transaction_date, description, amount_cents, category_id, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (&id, &input.account_id, &input.transaction_date, input.description.trim(), input.amount_cents, input.category_id, input.notes),
    ).map_err(|error| error.to_string())?;
    if let Some(recurrence) = input.schedule_recurrence.as_deref() {
        let modifier = match recurrence {
            "daily" => "+1 day", "weekly" => "+7 days", "biweekly" => "+14 days",
            "monthly" => "+1 month", "quarterly" => "+3 months", "yearly" => "+1 year",
            _ => return Err("Choose a valid recurrence period.".into()),
        };
        let next_date: String = transaction.query_row("SELECT date(?1, ?2)", (&input.transaction_date, modifier), |row| row.get(0))
            .map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO scheduled_transactions(id, account_id, start_date, description, amount_cents, recurrence)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            (new_id(), &input.account_id, next_date, input.description.trim(), input.amount_cents, recurrence),
        ).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(id)
}

#[tauri::command]
fn delete_transaction(app: AppHandle, transaction_id: String) -> Result<(), String> {
    let (connection, _) = open_database(&app)?;
    let deleted = connection.execute("DELETE FROM transactions WHERE id = ?1", [transaction_id]).map_err(|error| error.to_string())?;
    if deleted != 1 { return Err("Transaction no longer exists.".into()); }
    Ok(())
}

#[tauri::command]
fn update_transaction(app: AppHandle, input: UpdateTransactionInput) -> Result<(), String> {
    if input.description.trim().is_empty() { return Err("A transaction description is required.".into()); }
    if !input.transaction_date.chars().all(|character| character.is_ascii_digit() || character == '-') || input.transaction_date.len() != 10 {
        return Err("Transaction date must use YYYY-MM-DD.".into());
    }
    let (connection, _) = open_database(&app)?;
    let updated = connection.execute(
        "UPDATE transactions SET account_id = ?1, transaction_date = ?2, description = ?3, amount_cents = ?4, category_id = ?5, notes = ?6, updated_at = CURRENT_TIMESTAMP WHERE id = ?7",
        (&input.account_id, &input.transaction_date, input.description.trim(), input.amount_cents, input.category_id, input.notes, &input.id),
    ).map_err(|error| error.to_string())?;
    if updated != 1 { return Err("Transaction no longer exists.".into()); }
    Ok(())
}

#[tauri::command]
fn adjust_account_balance(app: AppHandle, input: AdjustAccountBalanceInput) -> Result<i64, String> {
    if !input.transaction_date.chars().all(|character| character.is_ascii_digit() || character == '-') || input.transaction_date.len() != 10 {
        return Err("Adjustment date must use YYYY-MM-DD.".into());
    }
    let (connection, _) = open_database(&app)?;
    let account: Option<(String, Option<i64>, i64)> = connection.query_row(
        "SELECT a.name, a.reported_balance_cents, a.opening_balance_cents + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id), 0) FROM accounts a WHERE a.id = ?1",
        [&input.account_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((account_name, reported_balance, calculated_balance)) = account else { return Err("Account no longer exists.".into()); };
    let current_balance = reported_balance.unwrap_or(calculated_balance);
    let adjustment = input.target_balance_cents - current_balance;
    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    if adjustment != 0 {
        transaction.execute(
            "INSERT INTO transactions(id, account_id, transaction_date, description, amount_cents, source, notes) VALUES(?1, ?2, ?3, ?4, ?5, 'adjustment', ?6)",
            (new_id(), &input.account_id, &input.transaction_date, format!("Balance adjustment · {account_name}"), adjustment, input.notes),
        ).map_err(|error| error.to_string())?;
    }
    if reported_balance.is_some() {
        transaction.execute("UPDATE accounts SET reported_balance_cents = ?1 WHERE id = ?2", (input.target_balance_cents, &input.account_id))
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(adjustment)
}

#[tauri::command]
fn ledger_data(app: AppHandle) -> Result<LedgerData, String> {
    let (connection, _) = open_database(&app)?;
    let mut statement = connection.prepare(
        "SELECT t.id, t.account_id, t.transaction_date, t.description, a.name, COALESCE(c.name, 'Uncategorized'), t.category_id, t.amount_cents
         FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
         ORDER BY t.transaction_date DESC, t.created_at DESC",
    ).map_err(|error| error.to_string())?;
    let transactions = statement.query_map([], |row| Ok(DashboardTransaction {
        id: row.get(0)?, account_id: row.get(1)?, transaction_date: row.get(2)?, description: row.get(3)?, account_name: row.get(4)?, category_name: row.get(5)?, category_id: row.get(6)?, amount_cents: row.get(7)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(LedgerData { transactions })
}

#[tauri::command]
fn categories_data(app: AppHandle) -> Result<Vec<CategoryEntry>, String> {
    let (connection, _) = open_database(&app)?;
    let mut statement = connection.prepare("SELECT id, name FROM categories ORDER BY name COLLATE NOCASE").map_err(|error| error.to_string())?;
    let entries = statement.query_map([], |row| Ok(CategoryEntry { id: row.get(0)?, name: row.get(1)? }))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(entries)
}

#[tauri::command]
fn create_category(app: AppHandle, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() { return Err("A category name is required.".into()); }
    let (connection, _) = open_database(&app)?;
    let id = new_id();
    connection.execute("INSERT INTO categories(id, name) VALUES(?1, ?2)", (&id, name)).map_err(|error| {
        if error.to_string().contains("UNIQUE") { "That category already exists.".into() } else { error.to_string() }
    })?;
    Ok(id)
}

#[tauri::command]
fn recurring_suggestions(app: AppHandle) -> Result<Vec<RecurringSuggestion>, String> {
    let (connection, _) = open_database(&app)?;
    let mut statement = connection.prepare(
        "WITH ordered AS (
           SELECT t.account_id, t.description, t.amount_cents, t.transaction_date, julianday(t.transaction_date) AS day_number,
             LAG(julianday(t.transaction_date)) OVER (PARTITION BY t.account_id, lower(t.description), t.amount_cents ORDER BY t.transaction_date) AS previous_day
           FROM transactions t WHERE t.source NOT IN ('scheduled', 'adjustment')
         ), grouped AS (
           SELECT account_id, description, amount_cents, MAX(transaction_date) AS last_date, COUNT(*) AS occurrences,
             AVG(CASE WHEN previous_day IS NOT NULL THEN day_number - previous_day END) AS average_days
           FROM ordered GROUP BY account_id, lower(description), amount_cents
         )
         SELECT g.account_id, a.name, g.description, g.amount_cents,
           CASE WHEN g.average_days BETWEEN 6 AND 8 THEN 'weekly' ELSE 'monthly' END,
           CASE WHEN g.average_days BETWEEN 6 AND 8 THEN date(g.last_date, '+7 days') ELSE date(g.last_date, '+1 month') END,
           g.occurrences
         FROM grouped g JOIN accounts a ON a.id = g.account_id
         WHERE g.occurrences >= 3 AND (g.average_days BETWEEN 6 AND 8 OR g.average_days BETWEEN 27 AND 33)
         ORDER BY g.occurrences DESC, g.description COLLATE NOCASE LIMIT 8"
    ).map_err(|error| error.to_string())?;
    let suggestions = statement.query_map([], |row| Ok(RecurringSuggestion {
        account_id: row.get(0)?, account_name: row.get(1)?, description: row.get(2)?, amount_cents: row.get(3)?, recurrence: row.get(4)?, next_occurrence: row.get(5)?, occurrences: row.get(6)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(suggestions)
}

#[tauri::command]
fn scheduled_data(app: AppHandle) -> Result<Vec<ScheduledEntry>, String> {
    let (connection, _) = open_database(&app)?;
    let mut statement = connection.prepare("SELECT s.id, s.account_id, s.start_date, s.end_date,
      CASE s.recurrence
        WHEN 'daily' THEN date(COALESCE(s.last_processed_occurrence, date(s.start_date, '-1 day')), '+1 day')
        WHEN 'weekly' THEN date(COALESCE(s.last_processed_occurrence, date(s.start_date, '-7 days')), '+7 days')
        WHEN 'biweekly' THEN date(COALESCE(s.last_processed_occurrence, date(s.start_date, '-14 days')), '+14 days')
        WHEN 'monthly' THEN date(COALESCE(s.last_processed_occurrence, date(s.start_date, '-1 month')), '+1 month')
        WHEN 'quarterly' THEN date(COALESCE(s.last_processed_occurrence, date(s.start_date, '-3 months')), '+3 months')
        ELSE date(COALESCE(s.last_processed_occurrence, date(s.start_date, '-1 year')), '+1 year') END,
      s.description, s.amount_cents, s.recurrence, a.name
      FROM scheduled_transactions s JOIN accounts a ON a.id = s.account_id WHERE s.active = 1 ORDER BY 5, s.description")
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(ScheduledEntry { id: row.get(0)?, account_id: row.get(1)?, start_date: row.get(2)?, end_date: row.get(3)?, next_occurrence: row.get(4)?, description: row.get(5)?, amount_cents: row.get(6)?, recurrence: row.get(7)?, account_name: row.get(8)? }))
        .map_err(|error| error.to_string())?;
    let entries = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        .into_iter().filter(|entry| entry.end_date.as_ref().map(|end| &entry.next_occurrence <= end).unwrap_or(true)).collect();
    Ok(entries)
}

#[tauri::command]
fn create_schedule(app: AppHandle, input: CreateScheduleInput) -> Result<String, String> {
    if input.description.trim().is_empty() { return Err("A scheduled transaction description is required.".into()); }
    if !matches!(input.recurrence.as_str(), "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly") { return Err("Choose a valid recurrence period.".into()); }
    let (connection, _) = open_database(&app)?;
    let id = new_id();
    if input.end_date.as_ref().is_some_and(|end| end < &input.start_date) { return Err("End date cannot be before the start date.".into()); }
    connection.execute("INSERT INTO scheduled_transactions(id, account_id, start_date, end_date, description, amount_cents, recurrence) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", (&id, input.account_id, input.start_date, input.end_date, input.description.trim(), input.amount_cents, input.recurrence))
        .map_err(|error| error.to_string())?;
    Ok(id)
}

#[tauri::command]
fn update_schedule(app: AppHandle, input: UpdateScheduleInput) -> Result<(), String> {
    if input.description.trim().is_empty() { return Err("A scheduled transaction description is required.".into()); }
    if !matches!(input.recurrence.as_str(), "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly") { return Err("Choose a valid recurrence period.".into()); }
    let (connection, _) = open_database(&app)?;
    if input.end_date.as_ref().is_some_and(|end| end < &input.start_date) { return Err("End date cannot be before the start date.".into()); }
    let updated = connection.execute(
        "UPDATE scheduled_transactions SET account_id = ?1, start_date = ?2, end_date = ?3, description = ?4, amount_cents = ?5, recurrence = ?6 WHERE id = ?7",
        (&input.account_id, &input.start_date, input.end_date, input.description.trim(), input.amount_cents, &input.recurrence, &input.id),
    ).map_err(|error| error.to_string())?;
    if updated != 1 { return Err("Scheduled transaction no longer exists.".into()); }
    Ok(())
}

fn process_schedule(app: AppHandle, schedule_id: String, record: bool) -> Result<String, String> {
    let (connection, _) = open_database(&app)?;
    let schedule: Option<(String, String, Option<String>, String, i64, String)> = connection.query_row(
        "SELECT account_id,
          CASE recurrence
            WHEN 'daily' THEN date(COALESCE(last_processed_occurrence, date(start_date, '-1 day')), '+1 day')
            WHEN 'weekly' THEN date(COALESCE(last_processed_occurrence, date(start_date, '-7 days')), '+7 days')
            WHEN 'biweekly' THEN date(COALESCE(last_processed_occurrence, date(start_date, '-14 days')), '+14 days')
            WHEN 'monthly' THEN date(COALESCE(last_processed_occurrence, date(start_date, '-1 month')), '+1 month')
            WHEN 'quarterly' THEN date(COALESCE(last_processed_occurrence, date(start_date, '-3 months')), '+3 months')
            ELSE date(COALESCE(last_processed_occurrence, date(start_date, '-1 year')), '+1 year') END,
          end_date, description, amount_cents, recurrence
          FROM scheduled_transactions WHERE id = ?1 AND active = 1",
        [&schedule_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((account_id, occurrence, end_date, description, amount_cents, _)) = schedule else { return Err("Scheduled transaction no longer exists.".into()); };
    if end_date.as_ref().is_some_and(|end| occurrence > *end) { return Err("This schedule has already ended.".into()); }
    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    if record {
        transaction.execute(
            "INSERT INTO transactions(id, account_id, transaction_date, description, amount_cents, source, notes) VALUES(?1, ?2, ?3, ?4, ?5, 'scheduled', 'Recorded from scheduled transaction')",
            (new_id(), account_id, &occurrence, description, amount_cents),
        ).map_err(|error| error.to_string())?;
    }
    transaction.execute("UPDATE scheduled_transactions SET last_processed_occurrence = ?1 WHERE id = ?2", (&occurrence, &schedule_id))
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(occurrence)
}

#[tauri::command]
fn record_schedule_occurrence(app: AppHandle, schedule_id: String) -> Result<String, String> {
    process_schedule(app, schedule_id, true)
}

#[tauri::command]
fn skip_schedule_occurrence(app: AppHandle, schedule_id: String) -> Result<String, String> {
    process_schedule(app, schedule_id, false)
}

fn broker_post(path: &str, body: Value, connection_secret: Option<&str>) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let mut request = client.post(format!("{SANDBOX_BROKER_BASE_URL}/{path}")).json(&body);
    if let Some(secret) = connection_secret {
        request = request.header("x-family-finance-connection-key", secret);
    }
    let response = request.send().map_err(|error| format!("Could not reach the Family Finance broker: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Sandbox broker request failed ({})", response.status()));
    }
    response.json().map_err(|error| format!("Sandbox broker response was invalid: {error}"))
}

fn broker_post_empty(path: &str, connection_secret: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::new().post(format!("{SANDBOX_BROKER_BASE_URL}/{path}"))
        .header("x-family-finance-connection-key", connection_secret)
        .send().map_err(|error| format!("Could not reach the Family Finance broker: {error}"))?;
    if !response.status().is_success() { return Err(format!("Sandbox broker request failed ({})", response.status())); }
    Ok(())
}

fn cents(value: &Value) -> Option<i64> {
    value.as_f64().map(|amount| (amount * 100.0).round() as i64)
}

fn apply_plaid_sync(app: &AppHandle, local_connection_id: &str, payload: &Value) -> Result<usize, String> {
    let (mut connection, _) = open_database(app)?;
    let institution = payload["connection"]["institutionName"].as_str().unwrap_or("Plaid Sandbox institution");
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let mut account_ids = std::collections::HashMap::new();
    for account in payload["accounts"].as_array().ok_or("Sandbox response has no accounts.")? {
        let external_account_id = account["account_id"].as_str().ok_or("Sandbox account has no id.")?;
        let name = account["name"].as_str().unwrap_or("Plaid account");
        let plaid_account_type = account["type"].as_str();
        let plaid_account_subtype = account["subtype"].as_str();
        let account_type = plaid_account_subtype.or(plaid_account_type).unwrap_or("other");
        let mask = account["mask"].as_str();
        let current_balance_cents = cents(&account["balances"]["current"]);
        let available_balance_cents = cents(&account["balances"]["available"]);
        let linked_account: Option<String> = transaction.query_row(
            "SELECT account_id FROM plaid_account_links WHERE plaid_connection_id = ?1 AND external_account_id = ?2",
            (local_connection_id, external_account_id),
            |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        let local_name = format!("{institution} · {name}");
        // The old developer fixture used the same account names and stable Plaid
        // transaction ids but had no connection link. Adopt it on the first real
        // Sandbox Link sync so the user does not see duplicate Platypus data.
        let existing = match linked_account {
            Some(account_id) => Some(account_id),
            None => transaction.query_row(
                "SELECT a.id FROM accounts a
                 WHERE a.name = ?1
                   AND NOT EXISTS(SELECT 1 FROM plaid_account_links l WHERE l.account_id = a.id)
                   AND EXISTS(SELECT 1 FROM transactions t WHERE t.account_id = a.id AND t.source = 'plaid-sandbox')
                 LIMIT 1",
                [&local_name],
                |row| row.get(0),
            ).optional().map_err(|error| error.to_string())?,
        };
        let is_new = existing.is_none();
        let account_id = existing.unwrap_or_else(new_id);
        if is_new {
            transaction.execute(
                "INSERT INTO accounts(id, name, type, opening_balance_cents, reported_balance_cents) VALUES(?1, ?2, ?3, 0, ?4)",
                (&account_id, &local_name, account_type, current_balance_cents),
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "INSERT INTO plaid_account_links(
                   plaid_connection_id, external_account_id, account_id, plaid_account_type, plaid_account_subtype,
                   mask, current_balance_cents, available_balance_cents, balance_refreshed_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)",
                (local_connection_id, external_account_id, &account_id, plaid_account_type, plaid_account_subtype,
                 mask, current_balance_cents, available_balance_cents),
            ).map_err(|error| error.to_string())?;
        } else {
            transaction.execute(
                "UPDATE accounts
                 SET name = ?1, type = ?2, reported_balance_cents = COALESCE(?3, reported_balance_cents)
                 WHERE id = ?4",
                (&local_name, account_type, current_balance_cents, &account_id),
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE plaid_account_links
                 SET plaid_account_type = ?1, plaid_account_subtype = ?2, mask = ?3,
                     current_balance_cents = ?4, available_balance_cents = ?5,
                     balance_refreshed_at = CURRENT_TIMESTAMP
                 WHERE plaid_connection_id = ?6 AND external_account_id = ?7",
                (plaid_account_type, plaid_account_subtype, mask, current_balance_cents, available_balance_cents,
                 local_connection_id, external_account_id),
            ).map_err(|error| error.to_string())?;
        }
        account_ids.insert(external_account_id.to_owned(), account_id);
    }

    let source = format!("plaid-sandbox:{local_connection_id}");
    let mut imported = 0;
    for item in payload["added"].as_array().into_iter().flatten().chain(payload["modified"].as_array().into_iter().flatten()) {
        let external_id = item["transaction_id"].as_str().ok_or("Sandbox transaction has no id.")?;
        let Some(account_id) = item["account_id"].as_str().and_then(|value| account_ids.get(value)) else { continue; };
        let amount = cents(&item["amount"]).ok_or("Sandbox transaction amount is invalid.")?;
        transaction.execute(
            "UPDATE transactions SET account_id = ?1, source = ?2
             WHERE source = 'plaid-sandbox' AND external_transaction_id = ?3",
            (account_id, &source, external_id),
        ).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO transactions(id, account_id, transaction_date, description, amount_cents, source, external_transaction_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(source, external_transaction_id) DO UPDATE SET
               account_id = excluded.account_id, transaction_date = excluded.transaction_date,
               description = excluded.description, amount_cents = excluded.amount_cents,
               updated_at = CURRENT_TIMESTAMP",
            (new_id(), account_id, item["date"].as_str().unwrap_or("1970-01-01"), item["name"].as_str().unwrap_or("Plaid transaction"), -amount, &source, external_id),
        ).map_err(|error| error.to_string())?;
        imported += 1;
    }
    for item in payload["removed"].as_array().into_iter().flatten() {
        if let Some(external_id) = item["transaction_id"].as_str() {
            transaction.execute("DELETE FROM transactions WHERE source = ?1 AND external_transaction_id = ?2", (&source, external_id))
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(imported)
}

#[tauri::command]
async fn create_plaid_sandbox_link_session() -> Result<SandboxLinkSession, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let payload = broker_post("link-token", Value::Object(Default::default()), None)?;
        Ok(SandboxLinkSession {
            link_token: payload["linkToken"].as_str().ok_or("Sandbox broker returned no Link token.")?.to_owned(),
            session_id: payload["sessionId"].as_str().ok_or("Sandbox broker returned no session id.")?.to_owned(),
            session_secret: payload["sessionSecret"].as_str().ok_or("Sandbox broker returned no session key.")?.to_owned(),
            expiration: payload["expiration"].as_str().unwrap_or_default().to_owned(),
        })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn complete_plaid_sandbox_link(app: AppHandle, input: CompleteSandboxLinkInput) -> Result<usize, String> {
    let session_id = input.session_id.clone();
    let session_secret = input.session_secret.clone();
    let broker_response = tauri::async_runtime::spawn_blocking(move || {
        broker_post("link-complete", serde_json::json!({
            "sessionId": input.session_id,
            "sessionSecret": input.session_secret,
            "publicToken": input.public_token,
            "institution": { "institution_id": input.institution_id, "name": input.institution_name }
        }), None)
    }).await.map_err(|error| error.to_string())??;
    let broker_connection_id = broker_response["connection"]["id"].as_str().ok_or("Sandbox broker returned no connection id.")?;
    let connection_secret = broker_response["connection"]["connectionSecret"].as_str().ok_or("Sandbox broker returned no connection key.")?;
    let institution_name = broker_response["connection"]["institutionName"].as_str().unwrap_or("Plaid Sandbox institution");
    let (connection, _) = open_database(&app)?;
    let local_connection_id = new_id();
    connection.execute(
        "INSERT INTO plaid_connections(id, broker_connection_id, connection_secret, institution_name, environment) VALUES(?1, ?2, ?3, ?4, 'sandbox')",
        (&local_connection_id, broker_connection_id, connection_secret, institution_name),
    ).map_err(|error| error.to_string())?;
    let _ = (session_id, session_secret); // The completion request consumes this one-time session at the broker.
    let payload = tauri::async_runtime::spawn_blocking({
        let id = broker_connection_id.to_owned();
        let key = connection_secret.to_owned();
        move || broker_post(&format!("connections/{id}/sync"), Value::Object(Default::default()), Some(&key))
    }).await.map_err(|error| error.to_string())??;
    apply_plaid_sync(&app, &local_connection_id, &payload)
}

#[tauri::command]
async fn sync_plaid_sandbox_connections(app: AppHandle) -> Result<usize, String> {
    let connections = {
        let (connection, _) = open_database(&app)?;
        let mut statement = connection.prepare("SELECT id, broker_connection_id, connection_secret FROM plaid_connections WHERE environment = 'sandbox'")
            .map_err(|error| error.to_string())?;
        let records = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
            .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        records
    };
    if connections.is_empty() { return Ok(0); }
    let payloads = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(String, Value)>, String> {
        connections.into_iter().map(|(local_id, broker_id, secret)| {
            broker_post(&format!("connections/{broker_id}/sync"), Value::Object(Default::default()), Some(&secret)).map(|payload| (local_id, payload))
        }).collect()
    }).await.map_err(|error| error.to_string())??;
    let mut changed = 0;
    for (local_id, payload) in payloads { changed += apply_plaid_sync(&app, &local_id, &payload)?; }
    Ok(changed)
}

#[tauri::command]
fn plaid_connections_data(app: AppHandle) -> Result<Vec<PlaidConnectionInfo>, String> {
    let (connection, _) = open_database(&app)?;
    let mut statement = connection.prepare("SELECT p.id, p.institution_name, p.environment, COUNT(l.account_id) FROM plaid_connections p LEFT JOIN plaid_account_links l ON l.plaid_connection_id = p.id GROUP BY p.id, p.institution_name, p.environment ORDER BY p.created_at DESC")
        .map_err(|error| error.to_string())?;
    let entries = statement.query_map([], |row| Ok(PlaidConnectionInfo { id: row.get(0)?, institution_name: row.get(1)?, environment: row.get(2)?, account_count: row.get(3)? }))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(entries)
}

#[tauri::command]
async fn disconnect_plaid_sandbox_connection(app: AppHandle, connection_id: String) -> Result<(), String> {
    let local = {
        let (connection, _) = open_database(&app)?;
        connection.query_row("SELECT broker_connection_id, connection_secret FROM plaid_connections WHERE id = ?1 AND environment = 'sandbox'", [&connection_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .optional().map_err(|error| error.to_string())?
    }.ok_or("Connected account is no longer available.")?;
    let (broker_id, secret) = local;
    tauri::async_runtime::spawn_blocking(move || broker_post_empty(&format!("connections/{broker_id}/disconnect"), &secret))
        .await.map_err(|error| error.to_string())??;
    let (connection, _) = open_database(&app)?;
    connection.execute("DELETE FROM plaid_connections WHERE id = ?1", [&connection_id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_plaid_sandbox(app: AppHandle) -> Result<usize, String> {
    let payload: Value = reqwest::blocking::get(SANDBOX_BROKER_URL).map_err(|error| error.to_string())?
        .error_for_status().map_err(|error| error.to_string())?.json().map_err(|error| error.to_string())?;
    let (connection, _) = open_database(&app)?;
    let mut account_ids = std::collections::HashMap::new();
    for account in payload["accounts"].as_array().ok_or("Sandbox response has no accounts.")? {
        let provider_id = account["account_id"].as_str().ok_or("Sandbox account has no id.")?;
        let name = account["name"].as_str().unwrap_or("Plaid Sandbox account");
        let local_name = format!("First Platypus Bank · {name}");
        let existing: Option<String> = connection.query_row("SELECT id FROM accounts WHERE name = ?1", [&local_name], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        let is_new = existing.is_none();
        let id = existing.unwrap_or_else(new_id);
        if is_new { connection.execute("INSERT INTO accounts(id, name, type, opening_balance_cents) VALUES(?1, ?2, ?3, 0)", (&id, &local_name, account["type"].as_str().unwrap_or("checking"))).map_err(|error| error.to_string())?; }
        account_ids.insert(provider_id.to_owned(), id);
    }
    let mut imported = 0;
    for item in payload["added"].as_array().ok_or("Sandbox response has no transactions.")? {
        let external_id = item["transaction_id"].as_str().ok_or("Sandbox transaction has no id.")?;
        let Some(account_id) = item["account_id"].as_str().and_then(|value| account_ids.get(value)) else { continue; };
        let amount = item["amount"].as_f64().ok_or("Sandbox amount is invalid.")?;
        let rows = connection.execute("INSERT OR IGNORE INTO transactions(id, account_id, transaction_date, description, amount_cents, source, external_transaction_id) VALUES(?1, ?2, ?3, ?4, ?5, 'plaid-sandbox', ?6)", (new_id(), account_id, item["date"].as_str().unwrap_or("1970-01-01"), item["name"].as_str().unwrap_or("Plaid transaction"), (-amount * 100.0).round() as i64, external_id)).map_err(|error| error.to_string())?;
        imported += rows;
    }
    Ok(imported)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![database_status, reset_unavailable_database, dashboard_data, create_account, create_transaction, update_transaction, delete_transaction, adjust_account_balance, ledger_data, categories_data, create_category, recurring_suggestions, scheduled_data, create_schedule, update_schedule, record_schedule_occurrence, skip_schedule_occurrence, import_plaid_sandbox, create_plaid_sandbox_link_session, complete_plaid_sandbox_link, sync_plaid_sandbox_connections, plaid_connections_data, disconnect_plaid_sandbox_connection])
        .run(tauri::generate_context!())
        .expect("error while running Family Finance");
}
