use rand::RngCore;
use rusqlite::{backup::Backup, params, Connection, OpenFlags};
use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};

pub const BACKUP_FORMAT_VERSION: u32 = 1;
pub const CURRENT_SCHEMA_VERSION: u32 = 11;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub path: String,
    pub created_at: u64,
    pub source_schema_version: u32,
    pub application_version: String,
}

fn timestamp() -> Result<u64, String> {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).map_err(|error| error.to_string())
}

fn nonce() -> String {
    let mut bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

fn apply_key(connection: &Connection, key: &str) -> Result<(), String> {
    if key.is_empty() { return Err("The database key is unavailable.".into()); }
    connection.pragma_update(None, "key", key).map_err(|error| error.to_string())?;
    connection.pragma_update(None, "foreign_keys", true).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn ensure_profile_metadata(connection: &Connection, profile_id: &str, environment: &str) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS profile_metadata(
           singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
           profile_id TEXT NOT NULL UNIQUE,
           environment TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );"
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT OR IGNORE INTO profile_metadata(singleton, profile_id, environment) VALUES(1, ?1, ?2)",
        params![profile_id, environment],
    ).map_err(|error| error.to_string())?;
    let stored: (String, String) = connection.query_row(
        "SELECT profile_id, environment FROM profile_metadata WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| error.to_string())?;
    if stored != (profile_id.to_string(), environment.to_string()) {
        return Err("The database profile identity conflicts with this application profile.".into());
    }
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<u32, String> {
    connection.query_row("SELECT max(version) FROM schema_migrations", [], |row| row.get(0)).map_err(|error| error.to_string())
}

fn copy_online(source: &Connection, destination: &Path, key: &str) -> Result<Connection, String> {
    if destination.exists() { return Err("Backup staging destination already exists.".into()); }
    let mut output = Connection::open(destination).map_err(|error| error.to_string())?;
    apply_key(&output, key)?;
    {
        let backup = Backup::new(source, &mut output).map_err(|error| error.to_string())?;
        backup.run_to_completion(64, Duration::from_millis(5), None).map_err(|error| error.to_string())?;
    }
    Ok(output)
}

fn validate_connection(
    connection: &Connection,
    profile_id: &str,
    environment: &str,
    maximum_schema_version: u32,
) -> Result<BackupSummary, String> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if integrity != "ok" { return Err(format!("Backup integrity validation failed: {integrity}")); }
    let foreign_key_errors: i64 = connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if foreign_key_errors != 0 { return Err("Backup foreign-key validation failed.".into()); }
    let metadata: (u32, String, String, u64, u32, String) = connection.query_row(
        "SELECT format_version, profile_id, environment, created_at, source_schema_version, application_version
         FROM money_map_backup_metadata WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(|_| "The file is not a recognized Money Map backup.".to_string())?;
    if metadata.0 != BACKUP_FORMAT_VERSION { return Err("The backup format is unsupported.".into()); }
    if metadata.1 != profile_id { return Err("The backup belongs to a different Money Map profile.".into()); }
    if metadata.2 != environment { return Err("The backup belongs to a different Money Map environment.".into()); }
    if metadata.4 > maximum_schema_version { return Err("The backup was created by a newer, incompatible Money Map schema.".into()); }
    Ok(BackupSummary {
        path: String::new(),
        created_at: metadata.3,
        source_schema_version: metadata.4,
        application_version: metadata.5,
    })
}

fn validate_profile_connection(connection: &Connection, profile_id: &str, environment: &str) -> Result<(), String> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if integrity != "ok" { return Err(format!("Profile integrity validation failed: {integrity}")); }
    let foreign_key_errors: i64 = connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if foreign_key_errors != 0 { return Err("Profile foreign-key validation failed.".into()); }
    let stored: (String, String) = connection.query_row(
        "SELECT profile_id, environment FROM profile_metadata WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| "The restored profile has no valid profile identity.".to_string())?;
    if stored != (profile_id.to_string(), environment.to_string()) { return Err("The restored profile identity does not match.".into()); }
    if schema_version(connection)? > CURRENT_SCHEMA_VERSION { return Err("The restored profile schema is newer than this Money Map build.".into()); }
    Ok(())
}

pub fn create_backup(
    source: &Connection,
    key: &str,
    directory: &Path,
    profile_id: &str,
    environment: &str,
    application_version: &str,
) -> Result<BackupSummary, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let created_at = timestamp()?;
    let unique = nonce();
    let staging = directory.join(format!(".money-map-profile-{created_at}-{unique}.staging"));
    let destination = directory.join(format!("money-map-profile-{created_at}-{unique}.moneymap-backup"));
    let result = (|| {
        let output = copy_online(source, &staging, key)?;
        let source_schema_version = schema_version(&output)?;
        output.execute_batch(
            "CREATE TABLE money_map_backup_metadata(
               singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
               format_version INTEGER NOT NULL,
               profile_id TEXT NOT NULL,
               environment TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               source_schema_version INTEGER NOT NULL,
               application_version TEXT NOT NULL
             );"
        ).map_err(|error| error.to_string())?;
        output.execute(
            "INSERT INTO money_map_backup_metadata VALUES(1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![BACKUP_FORMAT_VERSION, profile_id, environment, created_at, source_schema_version, application_version],
        ).map_err(|error| error.to_string())?;
        let mut summary = validate_connection(&output, profile_id, environment, CURRENT_SCHEMA_VERSION)?;
        drop(output);
        fs::rename(&staging, &destination).map_err(|error| error.to_string())?;
        summary.path = destination.display().to_string();
        Ok(summary)
    })();
    if result.is_err() && staging.exists() { let _ = fs::remove_file(&staging); }
    result
}

pub fn inspect_backup(
    path: &Path,
    key: &str,
    profile_id: &str,
    environment: &str,
) -> Result<BackupSummary, String> {
    if !path.is_file() { return Err("The selected Money Map backup does not exist.".into()); }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    apply_key(&connection, key)?;
    connection.query_row("SELECT COUNT(*) FROM sqlite_master", [], |_row| Ok(())).map_err(|_| "The selected backup cannot be decrypted with this Windows profile.".to_string())?;
    let mut summary = validate_connection(&connection, profile_id, environment, CURRENT_SCHEMA_VERSION)?;
    summary.path = path.display().to_string();
    Ok(summary)
}

pub fn list_backups(directory: &Path, key: &str, profile_id: &str, environment: &str) -> Result<Vec<BackupSummary>, String> {
    if !directory.exists() { return Ok(Vec::new()); }
    let mut summaries = fs::read_dir(directory).map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("moneymap-backup"))
        .filter_map(|path| inspect_backup(&path, key, profile_id, environment).ok())
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| right.created_at.cmp(&left.created_at).then_with(|| right.path.cmp(&left.path)));
    Ok(summaries)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    value.into()
}

pub fn restore_backup(
    backup_path: &Path,
    active_path: &Path,
    key: &str,
    profile_id: &str,
    environment: &str,
) -> Result<PathBuf, String> {
    inspect_backup(backup_path, key, profile_id, environment)?;
    let parent = active_path.parent().ok_or("The active profile path has no parent directory.")?;
    let unique = format!("{}-{}", timestamp()?, nonce());
    let staging = parent.join(format!("money-map.restore-{unique}.staging"));
    let archive = parent.join(format!("money-map.before-restore-{unique}.db"));
    let failed = parent.join(format!("money-map.failed-restore-{unique}.db"));
    let source = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    apply_key(&source, key)?;
    let staged = copy_online(&source, &staging, key)?;
    validate_connection(&staged, profile_id, environment, CURRENT_SCHEMA_VERSION)?;
    staged.execute("DROP TABLE money_map_backup_metadata", []).map_err(|error| error.to_string())?;
    validate_profile_connection(&staged, profile_id, environment)?;
    drop(staged);
    drop(source);

    if active_path.exists() { fs::rename(active_path, &archive).map_err(|error| error.to_string())?; }
    let mut archived_sidecars = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let original = sidecar(active_path, suffix);
        if original.exists() {
            let archived = sidecar(&archive, suffix);
            if let Err(error) = fs::rename(&original, &archived) {
                for (from, to) in archived_sidecars.iter().rev() { let _ = fs::rename(from, to); }
                if archive.exists() { let _ = fs::rename(&archive, active_path); }
                let _ = fs::remove_file(&staging);
                return Err(format!("Could not preserve an active profile sidecar: {error}"));
            }
            archived_sidecars.push((archived, original));
        }
    }
    if let Err(error) = fs::rename(&staging, active_path) {
        for (from, to) in archived_sidecars.iter().rev() { let _ = fs::rename(from, to); }
        if archive.exists() { let _ = fs::rename(&archive, active_path); }
        return Err(format!("Could not promote the restored profile: {error}"));
    }
    let restored = Connection::open(active_path).map_err(|error| error.to_string())?;
    apply_key(&restored, key)?;
    let restored_validation = validate_profile_connection(&restored, profile_id, environment);
    drop(restored);
    match restored_validation {
        Ok(()) => Ok(archive),
        Err(error) => {
            let _ = fs::rename(active_path, &failed);
            for (from, to) in archived_sidecars.iter().rev() { let _ = fs::rename(from, to); }
            if archive.exists() { let _ = fs::rename(&archive, active_path); }
            Err(format!("Restored profile validation failed and the prior profile was recovered: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(path: &Path, key: &str, profile: &str, environment: &str) -> Connection {
        let connection = Connection::open(path).unwrap();
        apply_key(&connection, key).unwrap();
        connection.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(10);
             CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES('alpha');"
        ).unwrap();
        ensure_profile_metadata(&connection, profile, environment).unwrap();
        connection
    }

    #[test]
    fn encrypted_backup_is_profile_bound_and_restorable() {
        let root = std::env::temp_dir().join(format!("money-map-backup-test-{}", nonce()));
        fs::create_dir(&root).unwrap();
        let active = root.join("money-map.db");
        let connection = fixture(&active, "test-key", "profile-a", "production");
        let backup = create_backup(&connection, "test-key", &root.join("backups"), "profile-a", "production", "test").unwrap();
        assert!(inspect_backup(Path::new(&backup.path), "wrong-key", "profile-a", "production").is_err());
        assert!(inspect_backup(Path::new(&backup.path), "test-key", "profile-b", "production").is_err());
        assert!(inspect_backup(Path::new(&backup.path), "test-key", "profile-a", "sandbox").is_err());
        connection.execute("DELETE FROM records", []).unwrap();
        drop(connection);
        let archive = restore_backup(Path::new(&backup.path), &active, "test-key", "profile-a", "production").unwrap();
        let restored = Connection::open(&active).unwrap();
        apply_key(&restored, "test-key").unwrap();
        assert_eq!(restored.query_row("SELECT COUNT(*) FROM records", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        drop(restored);
        fs::remove_dir_all(root).unwrap();
        assert!(!archive.exists());
    }

    #[test]
    fn corrupt_and_newer_backups_are_rejected() {
        let root = std::env::temp_dir().join(format!("money-map-backup-test-{}", nonce()));
        fs::create_dir(&root).unwrap();
        let active = root.join("money-map.db");
        let connection = fixture(&active, "test-key", "profile-a", "production");
        let backup = create_backup(&connection, "test-key", &root, "profile-a", "production", "test").unwrap();
        drop(connection);
        let corrupt = root.join("corrupt.moneymap-backup");
        fs::write(&corrupt, b"not a database").unwrap();
        assert!(inspect_backup(&corrupt, "test-key", "profile-a", "production").is_err());
        let newer = Connection::open(&backup.path).unwrap();
        apply_key(&newer, "test-key").unwrap();
        newer.execute("UPDATE money_map_backup_metadata SET source_schema_version = 999", []).unwrap();
        drop(newer);
        assert!(inspect_backup(Path::new(&backup.path), "test-key", "profile-a", "production").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
