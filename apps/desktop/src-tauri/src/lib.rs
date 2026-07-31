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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![database_status])
        .run(tauri::generate_context!())
        .expect("error while running Family Finance");
}
