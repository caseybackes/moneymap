use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

pub const FORMAT_VERSION: u32 = 1;
pub const INCLUDED_CATEGORIES: [&str; 5] = [
    "application and build versions",
    "operating system and runtime",
    "encrypted profile readability and schema",
    "migration and recovery state categories",
    "connection synchronization state category",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildProvenance {
    pub application_version: String,
    pub channel: String,
    pub source_revision: String,
    pub build_epoch: u64,
    pub tauri_version: String,
    pub rustc_version: String,
    pub operating_system: String,
    pub architecture: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDiagnostic {
    pub store_state: String,
    pub schema_version: Option<u32>,
    pub migration_state: String,
    pub recovery_state: String,
    pub synchronization_state: String,
    pub error_class: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportReport {
    pub format_version: u32,
    pub generated_at: u64,
    pub build: BuildProvenance,
    pub profile: ProfileDiagnostic,
    pub included_categories: Vec<String>,
}

pub fn build_provenance(channel: &str) -> BuildProvenance {
    BuildProvenance {
        application_version: env!("CARGO_PKG_VERSION").to_string(),
        channel: channel.to_string(),
        source_revision: env!("MONEY_MAP_BUILD_REVISION").to_string(),
        build_epoch: env!("MONEY_MAP_BUILD_EPOCH").parse().unwrap_or(0),
        tauri_version: tauri::VERSION.to_string(),
        rustc_version: env!("MONEY_MAP_RUSTC_VERSION").to_string(),
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
    }
}

pub fn summarize_profile(
    connection: &Connection,
    current_schema_version: u32,
    recovery_state: &str,
) -> Result<ProfileDiagnostic, String> {
    let schema_version = connection
        .query_row("SELECT max(version) FROM schema_migrations", [], |row| row.get::<_, Option<u32>>(0))
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let connection_configured = connection
        .query_row("SELECT EXISTS(SELECT 1 FROM plaid_connections LIMIT 1)", [], |row| row.get::<_, bool>(0))
        .unwrap_or(false);
    let migration_state = match schema_version {
        Some(version) if version == current_schema_version => "current",
        Some(version) if version < current_schema_version => "upgrade_required",
        Some(_) => "unsupported_newer_schema",
        None => "schema_unavailable",
    };
    Ok(ProfileDiagnostic {
        store_state: "readable".into(),
        schema_version,
        migration_state: migration_state.into(),
        recovery_state: recovery_state.into(),
        synchronization_state: if connection_configured { "configured" } else { "not_configured" }.into(),
        error_class: None,
    })
}

pub fn unavailable_profile(store_state: &str, recovery_state: &str) -> ProfileDiagnostic {
    ProfileDiagnostic {
        store_state: store_state.into(),
        schema_version: None,
        migration_state: "unavailable".into(),
        recovery_state: recovery_state.into(),
        synchronization_state: "unavailable".into(),
        error_class: Some(if store_state == "missing" { "profile_missing" } else { "profile_unreadable" }.into()),
    }
}

pub fn report(generated_at: u64, build: BuildProvenance, profile: ProfileDiagnostic) -> SupportReport {
    SupportReport {
        format_version: FORMAT_VERSION,
        generated_at,
        build,
        profile,
        included_categories: INCLUDED_CATEGORIES.iter().map(|value| (*value).to_string()).collect(),
    }
}

pub fn serialize(report: &SupportReport) -> Result<String, String> {
    serde_json::to_string_pretty(report).map(|value| format!("{value}\n")).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn support_report_is_an_allowlist_over_sensitive_profile_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
             INSERT INTO schema_migrations VALUES(11);
             CREATE TABLE accounts(id TEXT, name TEXT, mask TEXT);
             CREATE TABLE transactions(id TEXT, description TEXT, amount_cents INTEGER);
             CREATE TABLE plaid_connections(id TEXT, broker_connection_id TEXT, connection_secret TEXT, institution_name TEXT);
             INSERT INTO accounts VALUES('CANARY-ACCOUNT-ID', 'CANARY-PERSON-NAME', 'CANARY-MASK');
             INSERT INTO transactions VALUES('CANARY-TRANSACTION-ID', 'CANARY-MERCHANT', 987654321);
             INSERT INTO plaid_connections VALUES('CANARY-LOCAL-CONNECTION', 'CANARY-BROKER-CONNECTION', 'CANARY-CONNECTION-SECRET', 'CANARY-INSTITUTION');"
        ).unwrap();
        let profile = summarize_profile(&connection, 11, "healthy").unwrap();
        let serialized = serialize(&report(1, BuildProvenance {
            application_version: "0.1.0".into(), channel: "Production".into(), source_revision: "abc123".into(),
            build_epoch: 1, tauri_version: "2.test".into(), rustc_version: "rustc test".into(),
            operating_system: "windows".into(), architecture: "x86_64".into(),
        }, profile)).unwrap();
        let path_canary = ["C", ":", "\\", "Users", "\\", "CANARY-PERSON", "\\", "money-map.db"].concat();
        for canary in ["CANARY-ACCOUNT", "CANARY-PERSON", "CANARY-MASK", "CANARY-TRANSACTION", "CANARY-MERCHANT", "987654321", "CANARY-LOCAL", "CANARY-BROKER", "CANARY-CONNECTION-SECRET", "CANARY-INSTITUTION", path_canary.as_str()] {
            assert!(!serialized.contains(canary), "support report leaked prohibited canary class");
        }
        assert!(serialized.contains("\"schemaVersion\": 11"));
        assert!(serialized.contains("\"synchronizationState\": \"configured\""));
    }
}
