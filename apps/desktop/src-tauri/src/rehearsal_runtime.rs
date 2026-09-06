use keyring::Entry;
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::{Path, PathBuf}};

const FIXTURE_SOURCE: &str = include_str!("../../../../test-fixtures/upgrade-rehearsal/v1/profile.json");
const REHEARSAL_ID: &str = "com.caseybackes.moneymap.rehearsal";
const DATABASE_KEY_ACCOUNT: &str = "database-key-v1";
const RECOVERY_REGISTRY_ACCOUNT: &str = "synthetic-recovery-registry-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    fixture_format_version: u32,
    fixture_id: String,
    expected_logical_hash: String,
}

#[derive(Deserialize)]
struct FixtureCategory { id: String, name: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureAccount {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    opening_balance_cents: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureTransaction {
    id: String,
    account_id: String,
    date: String,
    description: String,
    amount_cents: i64,
    category_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSchedule {
    id: String,
    account_id: String,
    description: String,
    amount_cents: i64,
    recurrence: String,
    start_date: String,
}

#[derive(Deserialize, Serialize)]
struct FixtureRecoveryState { name: String, handles: Vec<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    manifest: FixtureManifest,
    categories: Vec<FixtureCategory>,
    accounts: Vec<FixtureAccount>,
    transactions: Vec<FixtureTransaction>,
    schedules: Vec<FixtureSchedule>,
    recovery_states: Vec<FixtureRecoveryState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest<'a> {
    fixture_id: &'a str,
    fixture_format_version: u32,
    source_schema_version: u32,
    expected_target_schema_version: u32,
    logical_hash: &'a str,
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(items) => {
            let mut keys = items.keys().collect::<Vec<_>>();
            keys.sort();
            format!("{{{}}}", keys.into_iter().map(|key| {
                format!("{}:{}", serde_json::to_string(key).expect("JSON object key"), canonical_json(&items[key]))
            }).collect::<Vec<_>>().join(","))
        }
        _ => value.to_string(),
    }
}

fn parse_fixture(source: &str) -> Result<(Fixture, String), String> {
    let mut logical: Value = serde_json::from_str(source).map_err(|error| error.to_string())?;
    logical.as_object_mut().ok_or("Fixture root must be an object.")?.remove("manifest");
    let logical_hash = format!("{:x}", Sha256::digest(canonical_json(&logical).as_bytes()));
    let fixture: Fixture = serde_json::from_str(source).map_err(|error| error.to_string())?;
    if fixture.manifest.fixture_format_version != 1 || fixture.manifest.fixture_id != "money-map-upgrade-rehearsal-v1" {
        return Err("Unsupported rehearsal fixture identity.".into());
    }
    if fixture.manifest.expected_logical_hash != logical_hash {
        return Err(format!("Fixture hash mismatch: expected {}, got {logical_hash}.", fixture.manifest.expected_logical_hash));
    }
    Ok((fixture, logical_hash))
}

fn rehearsal_root() -> Result<PathBuf, String> {
    let local = env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable.")?;
    Ok(PathBuf::from(local).join(REHEARSAL_ID).join("runtime"))
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    Ok(fs::symlink_metadata(path).map_err(|error| error.to_string())?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(not(windows))]
fn is_reparse_point(path: &Path) -> Result<bool, String> {
    Ok(fs::symlink_metadata(path).map_err(|error| error.to_string())?.file_type().is_symlink())
}

fn prepare_staging(root: &Path) -> Result<PathBuf, String> {
    if root.exists() { return Err(format!("Rehearsal runtime already exists: {}", root.display())); }
    let parent = root.parent().ok_or("Rehearsal runtime has no parent directory.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if is_reparse_point(parent)? { return Err("Rehearsal runtime parent is a reparse point.".into()); }
    let staging = parent.join("runtime.staging");
    if staging.exists() { return Err(format!("Rehearsal staging directory already exists: {}", staging.display())); }
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    Ok(staging)
}

fn fresh_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn create_fixture_database(path: &Path, key: &str, fixture: &Fixture) -> Result<(), String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection.pragma_update(None, "key", key).map_err(|error| error.to_string())?;
    connection.execute_batch(
        "PRAGMA cipher_memory_security = ON;
         PRAGMA foreign_keys = ON;
         CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL);
         CREATE TABLE categories(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
         CREATE TABLE accounts(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, opening_balance_cents INTEGER NOT NULL DEFAULT 0, reported_balance_cents INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
         CREATE TABLE transactions(id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), transaction_date TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL, category_id TEXT REFERENCES categories(id), notes TEXT, source TEXT NOT NULL DEFAULT 'manual', external_transaction_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(source, external_transaction_id));
         CREATE TABLE scheduled_transactions(id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), start_date TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL, recurrence TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_processed_occurrence TEXT, end_date TEXT);
         CREATE TABLE plaid_connections(id TEXT PRIMARY KEY NOT NULL, broker_connection_id TEXT NOT NULL UNIQUE, connection_secret TEXT NOT NULL, institution_name TEXT NOT NULL, environment TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, institution_id TEXT, selected_account_fingerprint TEXT);
         CREATE TABLE plaid_account_links(plaid_connection_id TEXT NOT NULL REFERENCES plaid_connections(id) ON DELETE CASCADE, external_account_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), plaid_account_type TEXT, plaid_account_subtype TEXT, mask TEXT, current_balance_cents INTEGER, available_balance_cents INTEGER, balance_refreshed_at TEXT, PRIMARY KEY(plaid_connection_id, external_account_id));
         CREATE TABLE external_connections(id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, environment TEXT NOT NULL, broker_connection_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
         INSERT INTO schema_migrations(version) VALUES (1),(2),(3),(4),(5),(6),(7);"
    ).map_err(|error| error.to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for item in &fixture.categories {
        transaction.execute("INSERT INTO categories(id,name) VALUES(?1,?2)", params![item.id, item.name]).map_err(|error| error.to_string())?;
    }
    for item in &fixture.accounts {
        transaction.execute("INSERT INTO accounts(id,name,type,opening_balance_cents) VALUES(?1,?2,?3,?4)", params![item.id, item.name, item.kind, item.opening_balance_cents]).map_err(|error| error.to_string())?;
    }
    for item in &fixture.transactions {
        transaction.execute("INSERT INTO transactions(id,account_id,transaction_date,description,amount_cents,category_id) VALUES(?1,?2,?3,?4,?5,?6)", params![item.id, item.account_id, item.date, item.description, item.amount_cents, item.category_id]).map_err(|error| error.to_string())?;
    }
    for item in &fixture.schedules {
        transaction.execute("INSERT INTO scheduled_transactions(id,account_id,start_date,description,amount_cents,recurrence) VALUES(?1,?2,?3,?4,?5,?6)", params![item.id, item.account_id, item.start_date, item.description, item.amount_cents, item.recurrence]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if integrity != "ok" { return Err(format!("Fixture integrity check failed: {integrity}")); }
    let foreign_key_failures: i64 = connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if foreign_key_failures != 0 { return Err("Fixture foreign-key check failed.".into()); }
    Ok(())
}

fn store_rehearsal_credentials(key: &str, fixture: &Fixture) -> Result<(), String> {
    Entry::new(REHEARSAL_ID, DATABASE_KEY_ACCOUNT).map_err(|error| error.to_string())?.set_password(key).map_err(|error| error.to_string())?;
    let registry = serde_json::to_string(&fixture.recovery_states).map_err(|error| error.to_string())?;
    if let Err(error) = Entry::new(REHEARSAL_ID, RECOVERY_REGISTRY_ACCOUNT).map_err(|error| error.to_string())?.set_password(&registry) {
        let _ = Entry::new(REHEARSAL_ID, DATABASE_KEY_ACCOUNT).and_then(|entry| entry.delete_credential());
        return Err(error.to_string());
    }
    Ok(())
}

fn generate() -> Result<PathBuf, String> {
    let (fixture, logical_hash) = parse_fixture(FIXTURE_SOURCE)?;
    let root = rehearsal_root()?;
    let staging = prepare_staging(&root)?;
    let key = fresh_key();
    let result = (|| {
        fs::create_dir(staging.join("backups")).map_err(|error| error.to_string())?;
        create_fixture_database(&staging.join("money-map.db"), &key, &fixture)?;
        let manifest = RuntimeManifest { fixture_id: &fixture.manifest.fixture_id, fixture_format_version: fixture.manifest.fixture_format_version, source_schema_version: 7, expected_target_schema_version: 9, logical_hash: &logical_hash };
        fs::write(staging.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        store_rehearsal_credentials(&key, &fixture)?;
        fs::rename(&staging, &root).map_err(|error| error.to_string())?;
        Ok(root.clone())
    })();
    if result.is_err() && staging.exists() { let _ = fs::remove_dir_all(&staging); }
    result
}

pub fn run() {
    match env::args().nth(1).as_deref() {
        Some("--validate-fixture") => match parse_fixture(FIXTURE_SOURCE) {
            Ok((fixture, hash)) => println!("Validated {} ({hash}).", fixture.manifest.fixture_id),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        },
        Some("--generate") => match generate() {
            Ok(path) => println!("Generated isolated rehearsal runtime at {}", path.display()),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        },
        _ => println!("Usage: money-map-rehearsal --validate-fixture | --generate"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_fixture_hash_is_valid() {
        let (fixture, hash) = parse_fixture(FIXTURE_SOURCE).unwrap();
        assert_eq!(fixture.manifest.expected_logical_hash, hash);
    }

    #[test]
    fn generated_database_is_encrypted_and_has_no_provider_authority() {
        let (fixture, _) = parse_fixture(FIXTURE_SOURCE).unwrap();
        let path = env::temp_dir().join(format!("money-map-rehearsal-{}.db", rand::random::<u64>()));
        let key = fresh_key();
        create_fixture_database(&path, &key, &fixture).unwrap();
        let connection = Connection::open(&path).unwrap();
        assert!(connection.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0)).is_err());
        connection.pragma_update(None, "key", &key).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM plaid_connections", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        drop(connection);
        fs::remove_file(path).unwrap();
    }
}
