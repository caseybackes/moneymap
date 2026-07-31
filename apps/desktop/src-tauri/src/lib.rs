use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use keyring::Entry;
use rand::RngCore;
use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.caseybackes.family-finance";
const KEYRING_ACCOUNT: &str = "database-key-v2";

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardTransaction {
    id: String,
    transaction_date: String,
    description: String,
    account_name: String,
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

fn open_database(app: &AppHandle) -> Result<(Connection, String), String> {
    let directory = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("family-finance-v2.db");
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
         INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);"
    ).map_err(|error| error.to_string())?;
    Ok((connection, path.display().to_string()))
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
        "SELECT a.id, a.name, a.type, a.opening_balance_cents + COALESCE(SUM(t.amount_cents), 0)
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         GROUP BY a.id, a.name, a.type, a.opening_balance_cents
         ORDER BY a.name COLLATE NOCASE",
    ).map_err(|error| error.to_string())?;
    let accounts = account_statement.query_map([], |row| Ok(DashboardAccount {
        id: row.get(0)?, name: row.get(1)?, account_type: row.get(2)?, balance_cents: row.get(3)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    let mut transaction_statement = connection.prepare(
        "SELECT t.id, t.transaction_date, t.description, a.name, t.amount_cents
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         ORDER BY t.transaction_date DESC, t.created_at DESC LIMIT 6",
    ).map_err(|error| error.to_string())?;
    let recent_transactions = transaction_statement.query_map([], |row| Ok(DashboardTransaction {
        id: row.get(0)?, transaction_date: row.get(1)?, description: row.get(2)?, account_name: row.get(3)?, amount_cents: row.get(4)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    Ok(DashboardData { income_cents, spending_cents, accounts, recent_transactions })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![database_status, dashboard_data])
        .run(tauri::generate_context!())
        .expect("error while running Family Finance");
}
