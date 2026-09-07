use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

pub const SCHEMA_VERSION: &str = "1.0.0";
pub const CAPABILITY_VERSION: &str = "0.1.0";
const DEFAULT_PAGE_SIZE: u32 = 25;
const MAX_PAGE_SIZE: u32 = 100;
const MAX_RECURRING_SCAN: u32 = 500;
const MAX_RECURRING_CANDIDATES: u32 = 20;
const MAX_SCHEDULE_MATCH_SCAN: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    Read,
    Propose,
    Confirm,
    Execute,
    ExternalEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordScope {
    Capabilities,
    Transactions,
    Schedules,
    RecurringAnalysis,
    Proposals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorType {
    User,
    InAppHarness,
    LocalMcpClient,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub actor_id: String,
    pub actor_type: ActorType,
    pub action_classes: Vec<ActionClass>,
    pub scopes: Vec<RecordScope>,
}

impl Actor {
    pub fn read_only(actor_id: impl Into<String>, actor_type: ActorType, scopes: Vec<RecordScope>) -> Self {
        Self { actor_id: actor_id.into(), actor_type, action_classes: vec![ActionClass::Read], scopes }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum FinanceToolError {
    AuthorizationDenied { actor_id: String, action: ActionClass, scope: RecordScope },
    InvalidRequest { field: String, message: String },
    InvalidCursor { cursor: String },
    BoundExceeded { field: String, maximum: u32, actual: u32 },
    Storage { operation: String, message: String },
}

impl fmt::Display for FinanceToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AuthorizationDenied { actor_id, action, scope } => {
                write!(formatter, "actor {actor_id:?} is not authorized for {action:?} on {scope:?}")
            }
            Self::InvalidRequest { field, message } => write!(formatter, "invalid {field}: {message}"),
            Self::InvalidCursor { cursor } => write!(formatter, "invalid pagination cursor {cursor:?}"),
            Self::BoundExceeded { field, maximum, actual } => {
                write!(formatter, "{field} exceeds maximum {maximum} (received {actual})")
            }
            Self::Storage { operation, message } => write!(formatter, "{operation} failed: {message}"),
        }
    }
}

impl std::error::Error for FinanceToolError {}

fn storage(operation: &str, error: rusqlite::Error) -> FinanceToolError {
    FinanceToolError::Storage { operation: operation.to_owned(), message: error.to_string() }
}

fn transactions_has_column(connection: &Connection, column: &str) -> Result<bool, FinanceToolError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('transactions') WHERE name = ?1)",
            [column],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| storage("inspect transaction schema", error))
}

pub fn authorize(
    actor: &Actor,
    action: ActionClass,
    scope: RecordScope,
) -> Result<(), FinanceToolError> {
    if actor.actor_id.trim().is_empty()
        || !actor.action_classes.contains(&action)
        || !actor.scopes.contains(&scope)
    {
        return Err(FinanceToolError::AuthorizationDenied {
            actor_id: actor.actor_id.clone(),
            action,
            scope,
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDescriptor {
    pub name: String,
    pub schema_version: String,
    pub capability_version: String,
    pub action_class: ActionClass,
    pub required_scopes: Vec<RecordScope>,
    pub request_schema: JsonValue,
    pub result_schema: JsonValue,
    pub pagination: Option<PaginationDescriptor>,
    pub freshness: String,
    pub consistency: String,
    pub idempotency: String,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginationDescriptor {
    pub strategy: String,
    pub default_page_size: u32,
    pub maximum_page_size: u32,
}

pub fn list_capabilities(actor: &Actor) -> Result<Vec<CapabilityDescriptor>, FinanceToolError> {
    authorize(actor, ActionClass::Read, RecordScope::Capabilities)?;
    let page = Some(PaginationDescriptor {
        strategy: "bounded_offset_cursor_v1".to_owned(),
        default_page_size: DEFAULT_PAGE_SIZE,
        maximum_page_size: MAX_PAGE_SIZE,
    });
    let envelope = json!({
        "schemaVersion": SCHEMA_VERSION,
        "recordRefs": "money-map:<kind>:<opaque-local-id>",
        "money": { "currency": "USD", "amountCents": "integer" }
    });
    Ok(vec![
        CapabilityDescriptor {
            name: "finance.capabilities.list".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Read,
            required_scopes: vec![RecordScope::Capabilities],
            request_schema: json!({ "type": "object", "additionalProperties": false }),
            result_schema: envelope.clone(),
            pagination: None,
            freshness: "registry compiled with the native application".to_owned(),
            consistency: "immutable for the running application version".to_owned(),
            idempotency: "safe read".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.transactions.search".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Read,
            required_scopes: vec![RecordScope::Transactions],
            request_schema: json!({ "type": "object", "description": "Bounded transaction filters" }),
            result_schema: envelope.clone(),
            pagination: page.clone(),
            freshness: "each record includes observedAt and syncedAt".to_owned(),
            consistency: "one local database connection; ordered by date descending then stable id".to_owned(),
            idempotency: "safe read".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.schedules.search".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Read,
            required_scopes: vec![RecordScope::Schedules],
            request_schema: json!({ "type": "object", "description": "Bounded schedule filters" }),
            result_schema: envelope.clone(),
            pagination: page,
            freshness: "createdAt plus computed nextOccurrence".to_owned(),
            consistency: "one local database connection; ordered by next occurrence then stable id".to_owned(),
            idempotency: "safe read".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.recurring.detect".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Read,
            required_scopes: vec![RecordScope::RecurringAnalysis, RecordScope::Schedules],
            request_schema: json!({ "type": "object", "description": "Bounded deterministic evidence scan" }),
            result_schema: envelope.clone(),
            pagination: None,
            freshness: "derived from cited transaction observations at query time".to_owned(),
            consistency: "bounded local snapshot; candidate order is deterministic".to_owned(),
            idempotency: "safe deterministic read for unchanged records".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.proposals.create_schedule".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Propose,
            required_scopes: vec![RecordScope::Proposals, RecordScope::Schedules],
            request_schema: json!({ "type": "object", "description": "Persist an inert schedule create or update proposal" }),
            result_schema: envelope.clone(),
            pagination: None,
            freshness: "proposal binds exact evidence and content-hash preconditions at creation".to_owned(),
            consistency: "proposal persistence and creation audit are atomic".to_owned(),
            idempotency: "caller key replays the identical proposal and rejects payload drift".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.proposals.get".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Read,
            required_scopes: vec![RecordScope::Proposals],
            request_schema: json!({ "type": "object", "description": "Read one proposal and refresh expiry" }),
            result_schema: envelope.clone(),
            pagination: None,
            freshness: "current persisted lifecycle state".to_owned(),
            consistency: "expiry transition and audit are atomic".to_owned(),
            idempotency: "safe read; first read after expiry records the expiry transition".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.proposals.reject".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Propose,
            required_scopes: vec![RecordScope::Proposals],
            request_schema: json!({ "type": "object", "description": "Reject the exact current proposal version" }),
            result_schema: envelope.clone(),
            pagination: None,
            freshness: "version checked at transition".to_owned(),
            consistency: "rejection and audit are atomic".to_owned(),
            idempotency: "terminal rejection cannot be applied twice".to_owned(),
            deprecated: false,
        },
        CapabilityDescriptor {
            name: "finance.proposals.execute_confirmed".to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            capability_version: CAPABILITY_VERSION.to_owned(),
            action_class: ActionClass::Execute,
            required_scopes: vec![RecordScope::Proposals, RecordScope::Schedules],
            request_schema: json!({ "type": "object", "description": "Execute one exact native-confirmed proposal" }),
            result_schema: envelope,
            pagination: None,
            freshness: "confirmation, expiry, and record preconditions revalidated at execution".to_owned(),
            consistency: "schedule mutation, lifecycle transition, outcome, and audit are atomic".to_owned(),
            idempotency: "caller key returns the original outcome without repeating the mutation".to_owned(),
            deprecated: false,
        },
    ])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Transaction,
    Schedule,
    Account,
    Category,
    Proposal,
    Audit,
    Profile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRef {
    pub kind: RecordKind,
    pub id: String,
    pub version: String,
}

pub(crate) fn content_version(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("sha256:{:x}", digest.finalize())
}

pub(crate) fn record_ref(kind: RecordKind, local_id: String, version: String) -> RecordRef {
    let kind_name = match kind {
        RecordKind::Transaction => "transaction",
        RecordKind::Schedule => "schedule",
        RecordKind::Account => "account",
        RecordKind::Category => "category",
        RecordKind::Proposal => "proposal",
        RecordKind::Audit => "audit",
        RecordKind::Profile => "profile",
    };
    RecordRef { kind, id: format!("money-map:{kind_name}:{local_id}"), version }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source: String,
    pub external_record_id: Option<String>,
    pub observed_at: String,
    pub synced_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub schema_version: String,
    pub capability_version: String,
    pub records: Vec<T>,
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}

fn page_bounds(page: &PageRequest) -> Result<(u32, u32), FinanceToolError> {
    let limit = page.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(FinanceToolError::BoundExceeded {
            field: "page.limit".to_owned(),
            maximum: MAX_PAGE_SIZE,
            actual: limit,
        });
    }
    let offset = match page.cursor.as_deref() {
        None => 0,
        Some(cursor) => cursor
            .strip_prefix("v1:o:")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| FinanceToolError::InvalidCursor { cursor: cursor.to_owned() })?,
    };
    Ok((limit, offset))
}

fn validate_date(field: &str, value: &Option<String>) -> Result<(), FinanceToolError> {
    if let Some(value) = value {
        let bytes = value.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
            || bytes.iter().enumerate().any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
        {
            return Err(FinanceToolError::InvalidRequest {
                field: field.to_owned(),
                message: "expected YYYY-MM-DD".to_owned(),
            });
        }
    }
    Ok(())
}

fn push_in_filter(sql: &mut String, values: &mut Vec<Value>, column: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    sql.push_str(" AND ");
    sql.push_str(column);
    sql.push_str(" IN (");
    for (index, item) in items.iter().enumerate() {
        if index > 0 { sql.push(','); }
        sql.push('?');
        values.push(Value::Text(item.clone()));
    }
    sql.push(')');
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSearchRequest {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub amount_cents_min: Option<i64>,
    pub amount_cents_max: Option<i64>,
    pub account_ids: Vec<String>,
    pub party: Option<String>,
    pub sources: Vec<String>,
    pub pending: Option<bool>,
    pub category_ids: Vec<String>,
    pub page: PageRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRecord {
    pub record_ref: RecordRef,
    pub account_ref: RecordRef,
    pub account_name: String,
    pub transaction_date: String,
    pub description: String,
    pub merchant_key: Option<String>,
    pub amount_cents: i64,
    pub currency: String,
    pub category_ref: Option<RecordRef>,
    pub category_name: Option<String>,
    pub pending: bool,
    pub provenance: Provenance,
}

pub fn search_transactions(
    connection: &Connection,
    actor: &Actor,
    request: &TransactionSearchRequest,
) -> Result<Page<TransactionRecord>, FinanceToolError> {
    authorize(actor, ActionClass::Read, RecordScope::Transactions)?;
    validate_date("dateFrom", &request.date_from)?;
    validate_date("dateTo", &request.date_to)?;
    if request.amount_cents_min.zip(request.amount_cents_max).is_some_and(|(min, max)| min > max) {
        return Err(FinanceToolError::InvalidRequest { field: "amountCents".to_owned(), message: "minimum exceeds maximum".to_owned() });
    }
    let (limit, offset) = page_bounds(&request.page)?;
    let merchant_key_expression = if transactions_has_column(connection, "merchant_key")? { "t.merchant_key" } else { "NULL" };
    let party_expression = if transactions_has_column(connection, "merchant_key")? {
        "COALESCE(NULLIF(t.merchant_key,''),t.description)"
    } else {
        "t.description"
    };
    let pending_expression = if transactions_has_column(connection, "pending")? { "t.pending" } else { "0" };
    let mut sql = format!(
        "SELECT t.id,t.account_id,a.name,t.transaction_date,t.description,{merchant_key_expression},t.amount_cents,\
         t.category_id,c.name,{pending_expression},t.source,t.external_transaction_id,t.updated_at \
         FROM transactions t JOIN accounts a ON a.id=t.account_id \
         LEFT JOIN categories c ON c.id=t.category_id WHERE 1=1"
    );
    let mut values = Vec::new();
    macro_rules! predicate {
        ($column:expr, $operator:expr, $value:expr) => {{
            sql.push_str(" AND "); sql.push_str($column); sql.push(' '); sql.push_str($operator); sql.push_str(" ?");
            values.push($value);
        }};
    }
    if let Some(value) = &request.date_from { predicate!("t.transaction_date", ">=", Value::Text(value.clone())); }
    if let Some(value) = &request.date_to { predicate!("t.transaction_date", "<=", Value::Text(value.clone())); }
    if let Some(value) = request.amount_cents_min { predicate!("t.amount_cents", ">=", Value::Integer(value)); }
    if let Some(value) = request.amount_cents_max { predicate!("t.amount_cents", "<=", Value::Integer(value)); }
    push_in_filter(&mut sql, &mut values, "t.account_id", &request.account_ids);
    if let Some(value) = request.party.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        predicate!(&format!("lower({party_expression})"), "LIKE", Value::Text(format!("%{}%", value.to_lowercase())));
    }
    push_in_filter(&mut sql, &mut values, "t.source", &request.sources);
    if let Some(value) = request.pending { predicate!(pending_expression, "=", Value::Integer(if value { 1 } else { 0 })); }
    push_in_filter(&mut sql, &mut values, "t.category_id", &request.category_ids);
    sql.push_str(" ORDER BY t.transaction_date DESC,t.id ASC LIMIT ? OFFSET ?");
    values.push(Value::Integer(i64::from(limit + 1)));
    values.push(Value::Integer(i64::from(offset)));

    let mut statement = connection.prepare(&sql).map_err(|error| storage("prepare transaction search", error))?;
    let mut records = statement.query_map(params_from_iter(values.iter()), |row| {
        let transaction_id: String = row.get(0)?;
        let account_id: String = row.get(1)?;
        let transaction_date: String = row.get(3)?;
        let category_id: Option<String> = row.get(7)?;
        let source: String = row.get(10)?;
        let synced_at: String = row.get(12)?;
        let account_name: String = row.get(2)?;
        let description: String = row.get(4)?;
        let merchant_key: Option<String> = row.get(5)?;
        let amount_cents: i64 = row.get(6)?;
        let category_name: Option<String> = row.get(8)?;
        let pending = row.get::<_, i64>(9)? != 0;
        let external_record_id: Option<String> = row.get(11)?;
        let transaction_version = content_version(&[
            &transaction_id, &account_id, &transaction_date, &description,
            &amount_cents.to_string(), &source, &synced_at,
        ]);
        Ok(TransactionRecord {
            record_ref: record_ref(RecordKind::Transaction, transaction_id, transaction_version),
            account_ref: record_ref(RecordKind::Account, account_id.clone(), content_version(&[&account_id, &account_name])),
            account_name,
            transaction_date: transaction_date.clone(),
            description,
            merchant_key,
            amount_cents,
            currency: "USD".to_owned(),
            category_ref: category_id.map(|id| {
                let version = content_version(&[&id, category_name.as_deref().unwrap_or("")]);
                record_ref(RecordKind::Category, id, version)
            }),
            category_name,
            pending,
            provenance: Provenance {
                source,
                external_record_id,
                observed_at: transaction_date,
                synced_at,
            },
        })
    }).map_err(|error| storage("query transactions", error))?
      .collect::<Result<Vec<_>, _>>().map_err(|error| storage("read transactions", error))?;
    let has_more = records.len() > limit as usize;
    records.truncate(limit as usize);
    Ok(Page {
        schema_version: SCHEMA_VERSION.to_owned(),
        capability_version: CAPABILITY_VERSION.to_owned(),
        records,
        next_cursor: has_more.then(|| format!("v1:o:{}", offset + limit)),
        warnings: Vec::new(),
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSearchRequest {
    pub account_ids: Vec<String>,
    pub party: Option<String>,
    pub amount_cents_min: Option<i64>,
    pub amount_cents_max: Option<i64>,
    pub recurrences: Vec<String>,
    pub active: Option<bool>,
    pub next_date_from: Option<String>,
    pub next_date_to: Option<String>,
    pub page: PageRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub record_ref: RecordRef,
    pub account_ref: RecordRef,
    pub account_name: String,
    pub description: String,
    pub amount_cents: i64,
    pub currency: String,
    pub recurrence: String,
    pub start_date: String,
    pub end_date: Option<String>,
    pub next_occurrence: String,
    pub active: bool,
    pub created_at: String,
}

const NEXT_OCCURRENCE_SQL: &str = "CASE s.recurrence \
 WHEN 'daily' THEN date(COALESCE(s.last_processed_occurrence,date(s.start_date,'-1 day')),'+1 day') \
 WHEN 'weekly' THEN date(COALESCE(s.last_processed_occurrence,date(s.start_date,'-7 days')),'+7 days') \
 WHEN 'biweekly' THEN date(COALESCE(s.last_processed_occurrence,date(s.start_date,'-14 days')),'+14 days') \
 WHEN 'monthly' THEN date(COALESCE(s.last_processed_occurrence,date(s.start_date,'-1 month')),'+1 month') \
 WHEN 'quarterly' THEN date(COALESCE(s.last_processed_occurrence,date(s.start_date,'-3 months')),'+3 months') \
 ELSE date(COALESCE(s.last_processed_occurrence,date(s.start_date,'-1 year')),'+1 year') END";

pub fn search_schedules(
    connection: &Connection,
    actor: &Actor,
    request: &ScheduleSearchRequest,
) -> Result<Page<ScheduleRecord>, FinanceToolError> {
    authorize(actor, ActionClass::Read, RecordScope::Schedules)?;
    validate_date("nextDateFrom", &request.next_date_from)?;
    validate_date("nextDateTo", &request.next_date_to)?;
    if request.amount_cents_min.zip(request.amount_cents_max).is_some_and(|(min, max)| min > max) {
        return Err(FinanceToolError::InvalidRequest { field: "amountCents".to_owned(), message: "minimum exceeds maximum".to_owned() });
    }
    let (limit, offset) = page_bounds(&request.page)?;
    let mut sql = format!(
        "SELECT s.id,s.account_id,a.name,s.description,s.amount_cents,s.recurrence,s.start_date,s.end_date,{NEXT_OCCURRENCE_SQL},s.active,s.created_at,s.last_processed_occurrence \
         FROM scheduled_transactions s JOIN accounts a ON a.id=s.account_id WHERE 1=1"
    );
    let mut values = Vec::new();
    macro_rules! predicate {
        ($column:expr, $operator:expr, $value:expr) => {{
            sql.push_str(" AND "); sql.push_str($column); sql.push(' '); sql.push_str($operator); sql.push_str(" ?");
            values.push($value);
        }};
    }
    push_in_filter(&mut sql, &mut values, "s.account_id", &request.account_ids);
    if let Some(value) = request.party.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        predicate!("lower(s.description)", "LIKE", Value::Text(format!("%{}%", value.to_lowercase())));
    }
    if let Some(value) = request.amount_cents_min { predicate!("s.amount_cents", ">=", Value::Integer(value)); }
    if let Some(value) = request.amount_cents_max { predicate!("s.amount_cents", "<=", Value::Integer(value)); }
    push_in_filter(&mut sql, &mut values, "s.recurrence", &request.recurrences);
    if let Some(value) = request.active { predicate!("s.active", "=", Value::Integer(if value { 1 } else { 0 })); }
    if let Some(value) = &request.next_date_from { predicate!(NEXT_OCCURRENCE_SQL, ">=", Value::Text(value.clone())); }
    if let Some(value) = &request.next_date_to { predicate!(NEXT_OCCURRENCE_SQL, "<=", Value::Text(value.clone())); }
    sql.push_str(&format!(" ORDER BY {NEXT_OCCURRENCE_SQL} ASC,s.id ASC LIMIT ? OFFSET ?"));
    values.push(Value::Integer(i64::from(limit + 1)));
    values.push(Value::Integer(i64::from(offset)));
    let mut statement = connection.prepare(&sql).map_err(|error| storage("prepare schedule search", error))?;
    let mut records = statement.query_map(params_from_iter(values.iter()), |row| {
        let schedule_id: String = row.get(0)?;
        let account_id: String = row.get(1)?;
        let account_name: String = row.get(2)?;
        let description: String = row.get(3)?;
        let amount_cents: i64 = row.get(4)?;
        let recurrence: String = row.get(5)?;
        let start_date: String = row.get(6)?;
        let end_date: Option<String> = row.get(7)?;
        let next_occurrence: String = row.get(8)?;
        let active = row.get::<_, i64>(9)? != 0;
        let created_at: String = row.get(10)?;
        let last_processed_occurrence: Option<String> = row.get(11)?;
        let version = content_version(&[
            &schedule_id, &account_id, &description, &amount_cents.to_string(), &recurrence,
            &start_date, end_date.as_deref().unwrap_or(""), &active.to_string(),
            last_processed_occurrence.as_deref().unwrap_or(""), &created_at,
        ]);
        Ok(ScheduleRecord {
            record_ref: record_ref(RecordKind::Schedule, schedule_id, version),
            account_ref: record_ref(RecordKind::Account, account_id.clone(), content_version(&[&account_id, &account_name])),
            account_name,
            description,
            amount_cents,
            currency: "USD".to_owned(),
            recurrence,
            start_date,
            end_date,
            next_occurrence,
            active,
            created_at,
        })
    }).map_err(|error| storage("query schedules", error))?
      .collect::<Result<Vec<_>, _>>().map_err(|error| storage("read schedules", error))?;
    let has_more = records.len() > limit as usize;
    records.truncate(limit as usize);
    Ok(Page {
        schema_version: SCHEMA_VERSION.to_owned(),
        capability_version: CAPABILITY_VERSION.to_owned(),
        records,
        next_cursor: has_more.then(|| format!("v1:o:{}", offset + limit)),
        warnings: Vec::new(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringDetectRequest {
    pub account_ids: Vec<String>,
    pub party: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub minimum_occurrences: Option<u32>,
    pub scan_limit: Option<u32>,
    pub maximum_candidates: Option<u32>,
}

impl Default for RecurringDetectRequest {
    fn default() -> Self {
        Self {
            account_ids: Vec::new(), party: None, date_from: None, date_to: None,
            minimum_occurrences: Some(2), scan_limit: Some(250), maximum_candidates: Some(8),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountDistribution {
    pub minimum_cents: i64,
    pub maximum_cents: i64,
    pub median_cents: i64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringObservation {
    pub transaction_ref: RecordRef,
    pub transaction_date: String,
    pub amount_cents: i64,
    pub description: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringCandidate {
    pub party_key: String,
    pub display_name: String,
    pub account_ref: RecordRef,
    pub account_name: String,
    pub recurrence: String,
    pub next_expected_date: Option<String>,
    pub confidence_basis_points: u16,
    pub amount_distribution: AmountDistribution,
    pub observed_interval_days: Vec<i64>,
    pub candidate_temporal_roles: Vec<String>,
    pub evidence: Vec<RecurringObservation>,
    pub matching_schedule_refs: Vec<RecordRef>,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringDetectResult {
    pub schema_version: String,
    pub capability_version: String,
    pub candidates: Vec<RecurringCandidate>,
    pub scanned_records: u32,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
struct DetectionRow {
    id: String,
    account_id: String,
    account_name: String,
    date: String,
    day_number: i64,
    description: String,
    party_key: String,
    amount_cents: i64,
    source: String,
    version: String,
}

fn normalized_party(value: &str) -> String {
    value.chars().map(|character| if character.is_alphanumeric() { character.to_ascii_lowercase() } else { ' ' })
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn inferred_recurrence(intervals: &[i64]) -> (&'static str, Option<&'static str>, u16) {
    if intervals.is_empty() { return ("insufficient_evidence", None, 3500); }
    let mut sorted = intervals.to_vec();
    sorted.sort_unstable();
    let median = sorted[sorted.len() / 2];
    match median {
        6..=8 => ("weekly", Some("+7 days"), 8500),
        12..=16 => ("biweekly", Some("+14 days"), 8250),
        25..=35 => ("monthly", Some("+1 month"), 8500),
        80..=100 => ("quarterly", Some("+3 months"), 8000),
        350..=380 => ("yearly", Some("+1 year"), 7750),
        _ => ("irregular", None, 4500),
    }
}

pub fn detect_recurring(
    connection: &Connection,
    actor: &Actor,
    request: &RecurringDetectRequest,
) -> Result<RecurringDetectResult, FinanceToolError> {
    authorize(actor, ActionClass::Read, RecordScope::RecurringAnalysis)?;
    authorize(actor, ActionClass::Read, RecordScope::Schedules)?;
    validate_date("dateFrom", &request.date_from)?;
    validate_date("dateTo", &request.date_to)?;
    let minimum = request.minimum_occurrences.unwrap_or(2);
    if !(2..=24).contains(&minimum) {
        return Err(FinanceToolError::BoundExceeded { field: "minimumOccurrences".to_owned(), maximum: 24, actual: minimum });
    }
    let scan_limit = request.scan_limit.unwrap_or(250);
    if scan_limit == 0 || scan_limit > MAX_RECURRING_SCAN {
        return Err(FinanceToolError::BoundExceeded { field: "scanLimit".to_owned(), maximum: MAX_RECURRING_SCAN, actual: scan_limit });
    }
    let candidate_limit = request.maximum_candidates.unwrap_or(8);
    if candidate_limit == 0 || candidate_limit > MAX_RECURRING_CANDIDATES {
        return Err(FinanceToolError::BoundExceeded { field: "maximumCandidates".to_owned(), maximum: MAX_RECURRING_CANDIDATES, actual: candidate_limit });
    }
    let party_expression = if transactions_has_column(connection, "merchant_key")? {
        "COALESCE(NULLIF(t.merchant_key,''),t.description)"
    } else {
        "t.description"
    };
    let posted_predicate = if transactions_has_column(connection, "pending")? { " AND t.pending=0" } else { "" };
    let mut sql = format!(
        "SELECT t.id,t.account_id,a.name,t.transaction_date,CAST(julianday(t.transaction_date) AS INTEGER),\
         t.description,{party_expression},t.amount_cents,t.source,t.updated_at \
         FROM transactions t JOIN accounts a ON a.id=t.account_id \
         WHERE t.source <> 'scheduled'{posted_predicate}"
    );
    let mut values = Vec::new();
    push_in_filter(&mut sql, &mut values, "t.account_id", &request.account_ids);
    if let Some(value) = request.party.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        sql.push_str(&format!(" AND lower({party_expression}) LIKE ?"));
        values.push(Value::Text(format!("%{}%", value.to_lowercase())));
    }
    if let Some(value) = &request.date_from { sql.push_str(" AND t.transaction_date>=?"); values.push(Value::Text(value.clone())); }
    if let Some(value) = &request.date_to { sql.push_str(" AND t.transaction_date<=?"); values.push(Value::Text(value.clone())); }
    sql.push_str(" ORDER BY t.transaction_date DESC,t.id ASC LIMIT ?");
    values.push(Value::Integer(i64::from(scan_limit + 1)));
    let mut statement = connection.prepare(&sql).map_err(|error| storage("prepare recurring detection", error))?;
    let mut rows = statement.query_map(params_from_iter(values.iter()), |row| {
        let raw_party: String = row.get(6)?;
        let id: String = row.get(0)?;
        let account_id: String = row.get(1)?;
        let date: String = row.get(3)?;
        let description: String = row.get(5)?;
        let amount_cents: i64 = row.get(7)?;
        let source: String = row.get(8)?;
        let updated_at: String = row.get(9)?;
        let version = content_version(&[&id, &account_id, &date, &description, &amount_cents.to_string(), &source, &updated_at]);
        Ok(DetectionRow {
            id, account_id, account_name: row.get(2)?, date,
            day_number: row.get(4)?, description, party_key: normalized_party(&raw_party),
            amount_cents, source, version,
        })
    }).map_err(|error| storage("query recurring detection", error))?
      .collect::<Result<Vec<_>, _>>().map_err(|error| storage("read recurring observations", error))?;
    let truncated = rows.len() > scan_limit as usize;
    rows.truncate(scan_limit as usize);
    let scanned_records = rows.len() as u32;
    let mut groups: BTreeMap<(String, String), Vec<DetectionRow>> = BTreeMap::new();
    for row in rows { groups.entry((row.account_id.clone(), row.party_key.clone())).or_default().push(row); }

    let schedule_request = ScheduleSearchRequest { active: Some(true), page: PageRequest { limit: Some(MAX_PAGE_SIZE), cursor: None }, ..Default::default() };
    let mut schedules = Vec::new();
    let mut cursor = None;
    loop {
        let mut page_request = schedule_request.clone();
        page_request.page.cursor = cursor;
        let page = search_schedules(connection, actor, &page_request)?;
        schedules.extend(page.records);
        if schedules.len() > MAX_SCHEDULE_MATCH_SCAN {
            return Err(FinanceToolError::BoundExceeded {
                field: "activeScheduleMatchScan".to_owned(), maximum: MAX_SCHEDULE_MATCH_SCAN as u32, actual: schedules.len() as u32,
            });
        }
        cursor = page.next_cursor;
        if cursor.is_none() { break; }
    }

    let mut candidates = Vec::new();
    for ((_account_id, party_key), mut observations) in groups {
        if observations.len() < minimum as usize { continue; }
        observations.sort_by(|left, right| left.date.cmp(&right.date).then(left.id.cmp(&right.id)));
        let intervals = observations.windows(2).map(|pair| pair[1].day_number - pair[0].day_number).collect::<Vec<_>>();
        let mut amounts = observations.iter().map(|row| row.amount_cents).collect::<Vec<_>>();
        amounts.sort_unstable();
        let median_amount = amounts[amounts.len() / 2];
        let (recurrence, modifier, mut confidence) = inferred_recurrence(&intervals);
        let amount_range = amounts[amounts.len() - 1].saturating_sub(amounts[0]).unsigned_abs();
        if amount_range > median_amount.unsigned_abs() / 10 { confidence = confidence.saturating_sub(1500); }
        if observations.len() == 2 { confidence = confidence.saturating_sub(1000); }
        let last = observations.last().expect("minimum occurrence validation");
        let next_expected_date = if let Some(modifier) = modifier {
            connection.query_row("SELECT date(?1,?2)", (&last.date, modifier), |row| row.get(0))
                .map_err(|error| storage("compute recurring next date", error))?
        } else { None };
        let match_tolerance = std::cmp::max(500_i64, median_amount.unsigned_abs().saturating_div(10).min(i64::MAX as u64) as i64);
        let matching_schedule_refs = schedules.iter().filter(|schedule| {
            if schedule.account_ref.id != format!("money-map:account:{}", last.account_id) { return false; }
            let schedule_party = normalized_party(&schedule.description);
            let party_match = schedule_party == party_key || schedule_party.contains(&party_key) || party_key.contains(&schedule_party);
            party_match && schedule.amount_cents.abs_diff(median_amount) <= match_tolerance as u64
        }).map(|schedule| schedule.record_ref.clone()).collect::<Vec<_>>();
        let display_name = last.description.clone();
        let evidence = observations.iter().map(|row| RecurringObservation {
            transaction_ref: record_ref(RecordKind::Transaction, row.id.clone(), row.version.clone()),
            transaction_date: row.date.clone(), amount_cents: row.amount_cents,
            description: row.description.clone(), source: row.source.clone(),
        }).collect();
        candidates.push(RecurringCandidate {
            party_key,
            display_name,
            account_ref: record_ref(
                RecordKind::Account,
                last.account_id.clone(),
                content_version(&[&last.account_id, &last.account_name]),
            ),
            account_name: last.account_name.clone(),
            recurrence: recurrence.to_owned(),
            next_expected_date,
            confidence_basis_points: confidence,
            amount_distribution: AmountDistribution {
                minimum_cents: amounts[0], maximum_cents: amounts[amounts.len() - 1], median_cents: median_amount, currency: "USD".to_owned(),
            },
            observed_interval_days: intervals,
            candidate_temporal_roles: vec!["settlement_date".to_owned()],
            evidence,
            matching_schedule_refs,
            explanation: format!("Detected {recurrence} settlement pattern from {} posted observations; statement due dates require separate evidence.", observations.len()),
        });
    }
    candidates.sort_by(|left, right| right.evidence.len().cmp(&left.evidence.len())
        .then(right.confidence_basis_points.cmp(&left.confidence_basis_points))
        .then(left.account_ref.id.cmp(&right.account_ref.id))
        .then(left.party_key.cmp(&right.party_key)));
    let candidate_truncated = candidates.len() > candidate_limit as usize;
    candidates.truncate(candidate_limit as usize);
    let mut warnings = Vec::new();
    if truncated { warnings.push(format!("transaction scan truncated at {scan_limit} records")); }
    if candidate_truncated { warnings.push(format!("candidate results truncated at {candidate_limit}")); }
    Ok(RecurringDetectResult {
        schema_version: SCHEMA_VERSION.to_owned(), capability_version: CAPABILITY_VERSION.to_owned(),
        candidates, scanned_records, truncated: truncated || candidate_truncated, warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL);\
             CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL);\
             CREATE TABLE transactions(\
               id TEXT PRIMARY KEY,account_id TEXT NOT NULL,transaction_date TEXT NOT NULL,description TEXT NOT NULL,\
               amount_cents INTEGER NOT NULL,category_id TEXT,source TEXT NOT NULL,external_transaction_id TEXT,\
               merchant_key TEXT,pending INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);\
             CREATE TABLE scheduled_transactions(\
               id TEXT PRIMARY KEY,account_id TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,description TEXT NOT NULL,\
               amount_cents INTEGER NOT NULL,recurrence TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,\
               last_processed_occurrence TEXT,created_at TEXT NOT NULL);\
             INSERT INTO accounts VALUES('checking','Primary Checking');\
             INSERT INTO categories VALUES('debt','Debt');",
        ).unwrap();
        connection
    }

    fn actor(scopes: Vec<RecordScope>) -> Actor { Actor::read_only("test-agent", ActorType::InAppHarness, scopes) }

    fn legacy_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL);\
             CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL);\
             CREATE TABLE transactions(\
               id TEXT PRIMARY KEY,account_id TEXT NOT NULL,transaction_date TEXT NOT NULL,description TEXT NOT NULL,\
               amount_cents INTEGER NOT NULL,category_id TEXT,source TEXT NOT NULL,external_transaction_id TEXT,\
               updated_at TEXT NOT NULL);\
             CREATE TABLE scheduled_transactions(\
               id TEXT PRIMARY KEY,account_id TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,description TEXT NOT NULL,\
               amount_cents INTEGER NOT NULL,recurrence TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,\
               last_processed_occurrence TEXT,created_at TEXT NOT NULL);\
             INSERT INTO accounts VALUES('checking','Primary Checking');\
             INSERT INTO categories VALUES('debt','Debt');\
             INSERT INTO transactions VALUES(\
               'legacy-1','checking','2026-05-11','AIDVANTAGE PAYMENT',-63729,'debt','manual',NULL,'2026-05-11T08:00:00Z');\
             INSERT INTO transactions VALUES(\
               'legacy-2','checking','2026-06-11','AIDVANTAGE PAYMENT',-63729,'debt','manual',NULL,'2026-06-11T08:00:00Z');",
        ).unwrap();
        connection
    }

    fn add_student_loan_fixture(connection: &Connection) {
        connection.execute(
            "INSERT INTO transactions VALUES(?1,'checking',?2,?3,?4,'debt','plaid:item-a',?5,'aidvantage',0,?6)",
            ("loan-1", "2026-05-11", "AIDVANTAGE PAYMENT", -63729_i64, "provider-1", "2026-05-12T08:00:00Z"),
        ).unwrap();
        connection.execute(
            "INSERT INTO transactions VALUES(?1,'checking',?2,?3,?4,'debt','plaid:item-a',?5,'aidvantage',0,?6)",
            ("loan-2", "2026-06-11", "US DEPT EDUCATION AIDVANTAGE", -63729_i64, "provider-2", "2026-06-12T08:00:00Z"),
        ).unwrap();
        connection.execute(
            "INSERT INTO transactions VALUES(?1,'checking',?2,?3,?4,'debt','plaid:item-a',?5,'aidvantage',0,?6)",
            ("loan-3", "2026-07-11", "AIDVANTAGE AUTOPAY", -63729_i64, "provider-3", "2026-07-12T08:00:00Z"),
        ).unwrap();
    }

    #[test]
    fn transaction_search_preserves_integer_cents_and_provenance() {
        let connection = database();
        add_student_loan_fixture(&connection);
        let result = search_transactions(
            &connection,
            &actor(vec![RecordScope::Transactions]),
            &TransactionSearchRequest { party: Some("aidvantage".to_owned()), page: PageRequest { limit: Some(2), cursor: None }, ..Default::default() },
        ).unwrap();
        assert_eq!(result.records.len(), 2);
        assert_eq!(result.records[0].amount_cents, -63729);
        assert_eq!(result.records[0].currency, "USD");
        assert_eq!(result.records[0].provenance.source, "plaid:item-a");
        assert!(result.records[0].record_ref.id.starts_with("money-map:transaction:"));
        assert_eq!(result.next_cursor.as_deref(), Some("v1:o:2"));
    }

    #[test]
    fn authorization_denies_missing_scope() {
        let error = search_transactions(
            &database(),
            &actor(vec![RecordScope::Schedules]),
            &TransactionSearchRequest::default(),
        ).unwrap_err();
        assert!(matches!(error, FinanceToolError::AuthorizationDenied { scope: RecordScope::Transactions, .. }));
    }

    #[test]
    fn readers_support_the_committed_transaction_schema() {
        let connection = legacy_database();
        let transactions = search_transactions(
            &connection,
            &actor(vec![RecordScope::Transactions]),
            &TransactionSearchRequest { party: Some("aidvantage".to_owned()), ..Default::default() },
        ).unwrap();
        assert_eq!(transactions.records.len(), 2);
        assert_eq!(transactions.records[0].merchant_key, None);
        assert!(!transactions.records[0].pending);

        let recurring = detect_recurring(
            &connection,
            &actor(vec![RecordScope::RecurringAnalysis, RecordScope::Schedules]),
            &RecurringDetectRequest { party: Some("aidvantage".to_owned()), ..Default::default() },
        ).unwrap();
        assert_eq!(recurring.candidates.len(), 1);
        assert_eq!(recurring.candidates[0].party_key, "aidvantage payment");
    }

    #[test]
    fn pagination_rejects_unbounded_page() {
        let error = search_transactions(
            &database(),
            &actor(vec![RecordScope::Transactions]),
            &TransactionSearchRequest { page: PageRequest { limit: Some(MAX_PAGE_SIZE + 1), cursor: None }, ..Default::default() },
        ).unwrap_err();
        assert!(matches!(error, FinanceToolError::BoundExceeded { field, maximum: MAX_PAGE_SIZE, .. } if field == "page.limit"));
    }

    #[test]
    fn recurring_student_loan_candidate_cites_evidence_and_matches_schedule() {
        let connection = database();
        add_student_loan_fixture(&connection);
        connection.execute(
            "INSERT INTO scheduled_transactions VALUES(\
              'loan-schedule','checking','2026-08-11',NULL,'Aidvantage student loan payment',-63729,'monthly',1,NULL,'2026-07-15T00:00:00Z')",
            [],
        ).unwrap();
        let result = detect_recurring(
            &connection,
            &actor(vec![RecordScope::RecurringAnalysis, RecordScope::Schedules]),
            &RecurringDetectRequest { party: Some("aidvantage".to_owned()), ..Default::default() },
        ).unwrap();
        assert_eq!(result.candidates.len(), 1);
        let candidate = &result.candidates[0];
        assert_eq!(candidate.recurrence, "monthly");
        assert_eq!(candidate.amount_distribution.median_cents, -63729);
        assert_eq!(candidate.evidence.len(), 3);
        assert_eq!(candidate.next_expected_date.as_deref(), Some("2026-08-11"));
        assert_eq!(candidate.matching_schedule_refs.len(), 1);
        assert_eq!(candidate.matching_schedule_refs[0].id, "money-map:schedule:loan-schedule");
        assert_eq!(candidate.candidate_temporal_roles, vec!["settlement_date"]);
    }

    #[test]
    fn schedule_search_is_bounded_and_deterministic() {
        let connection = database();
        for (id, date) in [("b", "2026-09-11"), ("a", "2026-08-11")] {
            connection.execute(
                "INSERT INTO scheduled_transactions VALUES(?1,'checking',?2,NULL,'Aidvantage',-63729,'monthly',1,NULL,'2026-07-15T00:00:00Z')",
                (id, date),
            ).unwrap();
        }
        let result = search_schedules(
            &connection,
            &actor(vec![RecordScope::Schedules]),
            &ScheduleSearchRequest { page: PageRequest { limit: Some(1), cursor: None }, ..Default::default() },
        ).unwrap();
        assert_eq!(result.records[0].record_ref.id, "money-map:schedule:a");
        assert_eq!(result.next_cursor.as_deref(), Some("v1:o:1"));
    }
}
