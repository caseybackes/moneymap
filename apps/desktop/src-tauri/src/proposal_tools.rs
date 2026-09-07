use crate::finance_tools::{
    authorize, content_version, record_ref, ActionClass, Actor, ActorType, RecordKind, RecordRef,
    RecordScope,
};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

const MAX_PROPOSAL_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;
const CONFIRMATION_LIFETIME_SECONDS: i64 = 2 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalError {
    Authorization(String),
    InvalidRequest(String),
    NotFound,
    StateConflict(String),
    IdempotencyConflict,
    Expired,
    Stale(Vec<RecordRef>),
    ConfirmationRequired,
    ExecutionFailed(String),
    Storage(String),
}

impl fmt::Display for ProposalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Authorization(message) | Self::InvalidRequest(message) | Self::StateConflict(message)
            | Self::ExecutionFailed(message) | Self::Storage(message) => formatter.write_str(message),
            Self::NotFound => formatter.write_str("proposal or referenced record was not found"),
            Self::IdempotencyConflict => formatter.write_str("idempotency key was already used for a different request"),
            Self::Expired => formatter.write_str("proposal or confirmation has expired"),
            Self::Stale(_) => formatter.write_str("proposal preconditions no longer match current records"),
            Self::ConfirmationRequired => formatter.write_str("a current native confirmation artifact is required"),
        }
    }
}

impl std::error::Error for ProposalError {}

fn storage(operation: &str, error: impl fmt::Display) -> ProposalError {
    ProposalError::Storage(format!("{operation} failed: {error}"))
}

fn permitted(actor: &Actor, action: ActionClass, scope: RecordScope) -> Result<(), ProposalError> {
    authorize(actor, action, scope).map_err(|error| ProposalError::Authorization(error.to_string()))
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 18];
    rand::rng().fill_bytes(&mut bytes);
    let suffix = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    format!("{prefix}_{suffix}")
}

fn digest_json<T: Serialize>(value: &T) -> Result<String, ProposalError> {
    let bytes = serde_json::to_vec(value).map_err(|error| storage("serialize digest input", error))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn timestamp(connection: &Connection, epoch: i64) -> Result<String, ProposalError> {
    connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1, 'unixepoch')",
            [epoch],
            |row| row.get(0),
        )
        .map_err(|error| storage("format timestamp", error))
}

fn parse_timestamp(connection: &Connection, value: &str) -> Result<i64, ProposalError> {
    connection
        .query_row("SELECT CAST(strftime('%s', ?1) AS INTEGER)", [value], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| storage("parse timestamp", error))?
        .ok_or_else(|| ProposalError::InvalidRequest("expiresAt must be an RFC 3339 timestamp".to_owned()))
}

fn local_id<'a>(reference: &'a RecordRef, expected: RecordKind) -> Result<&'a str, ProposalError> {
    if reference.kind != expected {
        return Err(ProposalError::InvalidRequest("record reference has the wrong kind".to_owned()));
    }
    let kind = match expected {
        RecordKind::Transaction => "transaction",
        RecordKind::Schedule => "schedule",
        RecordKind::Account => "account",
        RecordKind::Category => "category",
        RecordKind::Proposal => "proposal",
        RecordKind::Audit => "audit",
        RecordKind::Profile => "profile",
    };
    reference.id.strip_prefix(&format!("money-map:{kind}:"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ProposalError::InvalidRequest("record reference is malformed".to_owned()))
}

pub fn migrate(connection: &Connection) -> Result<(), ProposalError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS finance_proposals (
           id TEXT PRIMARY KEY NOT NULL,
           profile_id TEXT NOT NULL,
           proposal_type TEXT NOT NULL CHECK(proposal_type IN ('schedule.create','schedule.update')),
           state TEXT NOT NULL CHECK(state IN ('proposed','approved','rejected','expired','stale','executed','failed')),
           version INTEGER NOT NULL DEFAULT 1,
           created_by_actor_id TEXT NOT NULL,
           created_by_actor_type TEXT NOT NULL,
           before_json TEXT NOT NULL,
           after_json TEXT NOT NULL,
           effect_digest TEXT NOT NULL,
           evidence_json TEXT NOT NULL,
           assumptions_json TEXT NOT NULL,
           preconditions_json TEXT NOT NULL,
           created_at_epoch INTEGER NOT NULL,
           expires_at_epoch INTEGER NOT NULL,
           create_idempotency_key TEXT NOT NULL,
           request_digest TEXT NOT NULL,
           result_schedule_id TEXT,
           last_error TEXT,
           UNIQUE(profile_id, created_by_actor_id, create_idempotency_key)
         );
         CREATE TABLE IF NOT EXISTS finance_confirmation_artifacts (
           artifact_id TEXT PRIMARY KEY NOT NULL,
           proposal_id TEXT NOT NULL UNIQUE REFERENCES finance_proposals(id) ON DELETE CASCADE,
           proposal_version INTEGER NOT NULL,
           profile_id TEXT NOT NULL,
           actor_id TEXT NOT NULL,
           effect_digest TEXT NOT NULL,
           confirmed_at_epoch INTEGER NOT NULL,
           expires_at_epoch INTEGER NOT NULL,
           consumed_at_epoch INTEGER
         );
         CREATE TABLE IF NOT EXISTS finance_audit_events (
           id TEXT PRIMARY KEY NOT NULL,
           proposal_id TEXT NOT NULL REFERENCES finance_proposals(id) ON DELETE CASCADE,
           action TEXT NOT NULL,
           actor_id TEXT NOT NULL,
           from_state TEXT,
           to_state TEXT NOT NULL,
           created_at_epoch INTEGER NOT NULL,
           metadata_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS finance_execution_outcomes (
           idempotency_key TEXT PRIMARY KEY NOT NULL,
           proposal_id TEXT NOT NULL REFERENCES finance_proposals(id) ON DELETE CASCADE,
           result_schedule_id TEXT NOT NULL,
           audit_id TEXT NOT NULL REFERENCES finance_audit_events(id),
           created_at_epoch INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS finance_proposals_state_expiry ON finance_proposals(state, expires_at_epoch);
         CREATE INDEX IF NOT EXISTS finance_audit_proposal_time ON finance_audit_events(proposal_id, created_at_epoch, id);"
    ).map_err(|error| storage("migrate proposal lifecycle", error))?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScheduleOperation {
    #[serde(rename = "schedule.create")]
    Create,
    #[serde(rename = "schedule.update")]
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction { Inflow, Outflow }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmountPolicy { Fixed, Estimate, StatementAmount, Variable }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemporalRole { DueDate, PlannedDate, AutopayDate, ExpectedSettlementDate }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cadence { Daily, Weekly, Biweekly, Monthly, Quarterly, Annual }

impl Cadence {
    fn database_value(self) -> &'static str {
        match self {
            Self::Daily => "daily", Self::Weekly => "weekly", Self::Biweekly => "biweekly",
            Self::Monthly => "monthly", Self::Quarterly => "quarterly", Self::Annual => "yearly",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Money { pub currency: String, pub amount_cents: i64 }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEffect {
    pub operation: ScheduleOperation,
    pub target_schedule_ref: Option<RecordRef>,
    pub name: String,
    pub account_ref: RecordRef,
    pub direction: Direction,
    pub amount: Money,
    pub amount_policy: AmountPolicy,
    pub cadence: Cadence,
    pub temporal_role: TemporalRole,
    pub start_date: String,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSnapshot {
    pub schedule_ref: RecordRef,
    pub account_ref: RecordRef,
    pub name: String,
    pub amount_cents: i64,
    pub recurrence: String,
    pub start_date: String,
    pub end_date: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRole { Observation, Statement, Derived, UserAssertion, ExternalCitation }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    #[serde(rename = "ref")]
    pub record_ref: RecordRef,
    pub role: EvidenceRole,
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Precondition { pub record_ref: RecordRef, pub expected_version: String }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState { Proposed, Approved, Rejected, Expired, Stale, Executed, Failed }

impl ProposalState {
    fn database_value(self) -> &'static str {
        match self {
            Self::Proposed => "proposed", Self::Approved => "approved", Self::Rejected => "rejected",
            Self::Expired => "expired", Self::Stale => "stale", Self::Executed => "executed", Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, ProposalError> {
        match value {
            "proposed" => Ok(Self::Proposed), "approved" => Ok(Self::Approved), "rejected" => Ok(Self::Rejected),
            "expired" => Ok(Self::Expired), "stale" => Ok(Self::Stale), "executed" => Ok(Self::Executed),
            "failed" => Ok(Self::Failed),
            _ => Err(ProposalError::Storage(format!("unknown proposal state {value:?}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduleProposalRequest {
    pub effect: ScheduleEffect,
    pub evidence: Vec<EvidenceRef>,
    pub assumptions: Vec<String>,
    pub preconditions: Vec<Precondition>,
    pub expires_at: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalTransitionRequest {
    pub proposal_ref: RecordRef,
    pub expected_proposal_version: String,
    pub idempotency_key: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationArtifact {
    pub artifact_id: String,
    pub proposal_ref: RecordRef,
    pub proposal_version: String,
    pub profile_ref: RecordRef,
    pub actor_id: String,
    pub effect_digest: String,
    pub confirmed_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteConfirmedRequest {
    pub proposal_ref: RecordRef,
    pub expected_proposal_version: String,
    pub confirmation_artifact: ConfirmationArtifact,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmScheduleProposalRequest {
    pub proposal_ref: RecordRef,
    pub expected_proposal_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleProposal {
    pub proposal_ref: RecordRef,
    pub state: ProposalState,
    pub created_by_actor_id: String,
    pub created_by_actor_type: ActorType,
    pub before: Option<ScheduleSnapshot>,
    pub effect: ScheduleEffect,
    pub effect_digest: String,
    pub evidence: Vec<EvidenceRef>,
    pub assumptions: Vec<String>,
    pub preconditions: Vec<Precondition>,
    pub created_at: String,
    pub expires_at: String,
    pub create_idempotency_key: String,
    pub result_schedule_ref: Option<RecordRef>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleResult {
    pub proposal: ScheduleProposal,
    pub audit_ref: RecordRef,
    pub replayed: bool,
}

#[derive(Debug)]
struct StoredProposal {
    id: String,
    profile_id: String,
    state: ProposalState,
    version: i64,
    created_by_actor_id: String,
    created_by_actor_type: ActorType,
    before: Option<ScheduleSnapshot>,
    effect: ScheduleEffect,
    effect_digest: String,
    evidence: Vec<EvidenceRef>,
    assumptions: Vec<String>,
    preconditions: Vec<Precondition>,
    created_at_epoch: i64,
    expires_at_epoch: i64,
    create_idempotency_key: String,
    request_digest: String,
    result_schedule_id: Option<String>,
    last_error: Option<String>,
}

fn actor_type(value: &str) -> Result<ActorType, ProposalError> {
    match value {
        "user" => Ok(ActorType::User), "in_app_harness" => Ok(ActorType::InAppHarness),
        "local_mcp_client" => Ok(ActorType::LocalMcpClient), "system" => Ok(ActorType::System),
        _ => Err(ProposalError::Storage(format!("unknown actor type {value:?}"))),
    }
}

fn actor_type_value(value: ActorType) -> &'static str {
    match value {
        ActorType::User => "user", ActorType::InAppHarness => "in_app_harness",
        ActorType::LocalMcpClient => "local_mcp_client", ActorType::System => "system",
    }
}

fn load_stored(connection: &Connection, proposal_id: &str) -> Result<StoredProposal, ProposalError> {
    let row = connection.query_row(
        "SELECT id,profile_id,state,version,created_by_actor_id,created_by_actor_type,before_json,after_json,
                effect_digest,evidence_json,assumptions_json,preconditions_json,created_at_epoch,expires_at_epoch,
                create_idempotency_key,request_digest,result_schedule_id,last_error
         FROM finance_proposals WHERE id=?1",
        [proposal_id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?,
            row.get::<_, String>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?,
            row.get::<_, i64>(12)?, row.get::<_, i64>(13)?, row.get::<_, String>(14)?, row.get::<_, String>(15)?,
            row.get::<_, Option<String>>(16)?, row.get::<_, Option<String>>(17)?,
        )),
    ).optional().map_err(|error| storage("load proposal", error))?.ok_or(ProposalError::NotFound)?;
    Ok(StoredProposal {
        id: row.0,
        profile_id: row.1,
        state: ProposalState::parse(&row.2)?,
        version: row.3,
        created_by_actor_id: row.4,
        created_by_actor_type: actor_type(&row.5)?,
        before: serde_json::from_str(&row.6).map_err(|error| storage("decode proposal before payload", error))?,
        effect: serde_json::from_str(&row.7).map_err(|error| storage("decode proposal effect", error))?,
        effect_digest: row.8,
        evidence: serde_json::from_str(&row.9).map_err(|error| storage("decode proposal evidence", error))?,
        assumptions: serde_json::from_str(&row.10).map_err(|error| storage("decode proposal assumptions", error))?,
        preconditions: serde_json::from_str(&row.11).map_err(|error| storage("decode proposal preconditions", error))?,
        created_at_epoch: row.12,
        expires_at_epoch: row.13,
        create_idempotency_key: row.14,
        request_digest: row.15,
        result_schedule_id: row.16,
        last_error: row.17,
    })
}

fn proposal_ref(proposal: &StoredProposal) -> RecordRef {
    record_ref(RecordKind::Proposal, proposal.id.clone(), format!("v{}", proposal.version))
}

fn into_proposal(connection: &Connection, stored: StoredProposal) -> Result<ScheduleProposal, ProposalError> {
    let result_schedule_ref = stored.result_schedule_id.as_ref().map(|id| {
        let version = current_record_version(connection, &record_ref(RecordKind::Schedule, id.clone(), String::new()))
            .ok().flatten().unwrap_or_else(|| "deleted".to_owned());
        record_ref(RecordKind::Schedule, id.clone(), version)
    });
    Ok(ScheduleProposal {
        proposal_ref: proposal_ref(&stored),
        state: stored.state,
        created_by_actor_id: stored.created_by_actor_id,
        created_by_actor_type: stored.created_by_actor_type,
        before: stored.before,
        effect: stored.effect,
        effect_digest: stored.effect_digest,
        evidence: stored.evidence,
        assumptions: stored.assumptions,
        preconditions: stored.preconditions,
        created_at: timestamp(connection, stored.created_at_epoch)?,
        expires_at: timestamp(connection, stored.expires_at_epoch)?,
        create_idempotency_key: stored.create_idempotency_key,
        result_schedule_ref,
        last_error: stored.last_error,
    })
}

fn audit(
    connection: &Connection,
    proposal_id: &str,
    action: &str,
    actor_id: &str,
    from_state: Option<ProposalState>,
    to_state: ProposalState,
    now_epoch: i64,
    metadata: &serde_json::Value,
) -> Result<String, ProposalError> {
    let id = random_id("audit");
    connection.execute(
        "INSERT INTO finance_audit_events(id,proposal_id,action,actor_id,from_state,to_state,created_at_epoch,metadata_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, proposal_id, action, actor_id, from_state.map(ProposalState::database_value),
            to_state.database_value(), now_epoch, serde_json::to_string(metadata).map_err(|error| storage("encode audit metadata", error))?],
    ).map_err(|error| storage("append proposal audit", error))?;
    Ok(id)
}

fn current_record_version(connection: &Connection, reference: &RecordRef) -> Result<Option<String>, ProposalError> {
    let result = match reference.kind {
        RecordKind::Account => {
            let id = local_id(reference, RecordKind::Account)?;
            connection.query_row(
                "SELECT id,name FROM accounts WHERE id=?1",
                [id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            ).optional().map_err(|error| storage("version account", error))?
                .map(|row| content_version(&[&row.0,&row.1]))
        }
        RecordKind::Transaction => {
            let id = local_id(reference, RecordKind::Transaction)?;
            connection.query_row(
                "SELECT id,account_id,transaction_date,description,amount_cents,source,updated_at FROM transactions WHERE id=?1",
                [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,row.get::<_, i64>(4)?.to_string(),row.get::<_, String>(5)?,row.get::<_, String>(6)?))
            ).optional().map_err(|error| storage("version transaction", error))?
                .map(|row| content_version(&[&row.0,&row.1,&row.2,&row.3,&row.4,&row.5,&row.6]))
        }
        RecordKind::Schedule => {
            let id = local_id(reference, RecordKind::Schedule)?;
            connection.query_row(
                "SELECT id,account_id,start_date,COALESCE(end_date,''),description,amount_cents,recurrence,active,
                        COALESCE(last_processed_occurrence,''),created_at FROM scheduled_transactions WHERE id=?1",
                [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,row.get::<_, String>(4)?,row.get::<_, i64>(5)?.to_string(),
                    row.get::<_, String>(6)?,row.get::<_, i64>(7)?.to_string(),row.get::<_, String>(8)?,row.get::<_, String>(9)?))
            ).optional().map_err(|error| storage("version schedule", error))?
                .map(|row| content_version(&[&row.0,&row.1,&row.4,&row.5,&row.6,&row.2,&row.3,&row.7,&row.8,&row.9]))
        }
        _ => return Err(ProposalError::InvalidRequest("record kind cannot be used as a proposal precondition".to_owned())),
    };
    Ok(result)
}

fn schedule_snapshot(connection: &Connection, reference: &RecordRef) -> Result<ScheduleSnapshot, ProposalError> {
    let id = local_id(reference, RecordKind::Schedule)?;
    let row = connection.query_row(
        "SELECT s.id,s.account_id,s.start_date,s.end_date,s.description,s.amount_cents,s.recurrence,s.active,a.name
         FROM scheduled_transactions s JOIN accounts a ON a.id=s.account_id WHERE s.id=?1",
        [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,row.get::<_, String>(4)?,row.get::<_, i64>(5)?,
            row.get::<_, String>(6)?,row.get::<_, i64>(7)? != 0,row.get::<_, String>(8)?))
    ).optional().map_err(|error| storage("load schedule snapshot", error))?.ok_or(ProposalError::NotFound)?;
    let version = current_record_version(connection, reference)?.ok_or(ProposalError::NotFound)?;
    Ok(ScheduleSnapshot {
        schedule_ref: record_ref(RecordKind::Schedule, row.0, version),
        account_ref: record_ref(RecordKind::Account, row.1.clone(), content_version(&[&row.1,&row.8])),
        start_date: row.2, end_date: row.3, name: row.4, amount_cents: row.5,
        recurrence: row.6, active: row.7,
    })
}

fn validate_effect(effect: &ScheduleEffect) -> Result<(), ProposalError> {
    if effect.name.trim().is_empty() || effect.name.len() > 300 {
        return Err(ProposalError::InvalidRequest("schedule name must contain 1 to 300 characters".to_owned()));
    }
    if effect.amount.currency != "USD" || effect.amount.amount_cents < 0 {
        return Err(ProposalError::InvalidRequest("schedule amount must be non-negative integer cents in USD".to_owned()));
    }
    if effect.start_date.len() != 10 || effect.end_date.as_ref().is_some_and(|end| end < &effect.start_date) {
        return Err(ProposalError::InvalidRequest("schedule dates are invalid".to_owned()));
    }
    match effect.operation {
        ScheduleOperation::Create if effect.target_schedule_ref.is_some() =>
            Err(ProposalError::InvalidRequest("schedule.create cannot name a target schedule".to_owned())),
        ScheduleOperation::Update if effect.target_schedule_ref.is_none() =>
            Err(ProposalError::InvalidRequest("schedule.update requires a target schedule".to_owned())),
        _ => Ok(()),
    }
}

fn validate_effect_dates(connection: &Connection, effect: &ScheduleEffect) -> Result<(), ProposalError> {
    let start_valid: bool = connection.query_row(
        "SELECT date(?1)=?1", [&effect.start_date], |row| row.get(0)
    ).map_err(|error| storage("validate schedule start date", error))?;
    let end_valid = match &effect.end_date {
        Some(end) => connection.query_row("SELECT date(?1)=?1", [end], |row| row.get::<_, bool>(0))
            .map_err(|error| storage("validate schedule end date", error))?,
        None => true,
    };
    if !start_valid || !end_valid {
        return Err(ProposalError::InvalidRequest("schedule dates must be real YYYY-MM-DD dates".to_owned()));
    }
    Ok(())
}

fn canonical_preconditions(
    connection: &Connection,
    request: &CreateScheduleProposalRequest,
) -> Result<(Vec<Precondition>, Option<ScheduleSnapshot>), ProposalError> {
    let mut references = BTreeMap::<String, RecordRef>::new();
    references.insert(request.effect.account_ref.id.clone(), request.effect.account_ref.clone());
    for evidence in &request.evidence {
        references.insert(evidence.record_ref.id.clone(), evidence.record_ref.clone());
    }
    let before = if let Some(target) = &request.effect.target_schedule_ref {
        references.insert(target.id.clone(), target.clone());
        Some(schedule_snapshot(connection, target)?)
    } else { None };
    for precondition in &request.preconditions {
        if precondition.expected_version != precondition.record_ref.version {
            return Err(ProposalError::InvalidRequest("precondition version must match its record reference".to_owned()));
        }
        references.insert(precondition.record_ref.id.clone(), precondition.record_ref.clone());
    }
    let mut canonical = Vec::new();
    for (_, mut reference) in references {
        let current = current_record_version(connection, &reference)?.ok_or(ProposalError::NotFound)?;
        if !reference.version.is_empty() && reference.version != current {
            return Err(ProposalError::Stale(vec![reference]));
        }
        reference.version = current.clone();
        canonical.push(Precondition { record_ref: reference, expected_version: current });
    }
    Ok((canonical, before))
}

pub fn create_schedule_proposal(
    connection: &mut Connection,
    actor: &Actor,
    profile_id: &str,
    request: &CreateScheduleProposalRequest,
    now_epoch: i64,
) -> Result<LifecycleResult, ProposalError> {
    permitted(actor, ActionClass::Propose, RecordScope::Proposals)?;
    permitted(actor, ActionClass::Read, RecordScope::Schedules)?;
    validate_effect(&request.effect)?;
    validate_effect_dates(connection, &request.effect)?;
    if profile_id.trim().is_empty() || request.evidence.is_empty() || request.idempotency_key.len() < 8 || request.idempotency_key.len() > 200 {
        return Err(ProposalError::InvalidRequest("profile, evidence, and an 8-to-200 character idempotency key are required".to_owned()));
    }
    let expires_at_epoch = parse_timestamp(connection, &request.expires_at)?;
    if expires_at_epoch <= now_epoch || expires_at_epoch - now_epoch > MAX_PROPOSAL_LIFETIME_SECONDS {
        return Err(ProposalError::InvalidRequest("proposal expiry must be in the next seven days".to_owned()));
    }
    let (preconditions, before) = canonical_preconditions(connection, request)?;
    let effect_digest = digest_json(&request.effect)?;
    let request_digest = digest_json(&(profile_id, actor.actor_id.as_str(), &request.effect, &request.evidence,
        &request.assumptions, &preconditions, expires_at_epoch))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage("begin proposal creation", error))?;
    if let Some(id) = transaction.query_row(
        "SELECT id FROM finance_proposals WHERE profile_id=?1 AND created_by_actor_id=?2 AND create_idempotency_key=?3",
        params![profile_id, actor.actor_id, request.idempotency_key], |row| row.get::<_, String>(0)
    ).optional().map_err(|error| storage("find proposal idempotency record", error))? {
        let existing = load_stored(&transaction, &id)?;
        if existing.request_digest != request_digest { return Err(ProposalError::IdempotencyConflict); }
        let audit_id = transaction.query_row(
            "SELECT id FROM finance_audit_events WHERE proposal_id=?1 ORDER BY created_at_epoch DESC,id DESC LIMIT 1",
            [&id], |row| row.get::<_, String>(0)
        ).map_err(|error| storage("load proposal audit", error))?;
        let proposal = into_proposal(&transaction, existing)?;
        transaction.commit().map_err(|error| storage("commit idempotent proposal read", error))?;
        return Ok(LifecycleResult { proposal, audit_ref: record_ref(RecordKind::Audit, audit_id, "v1".to_owned()), replayed: true });
    }
    let id = random_id("proposal");
    transaction.execute(
        "INSERT INTO finance_proposals(id,profile_id,proposal_type,state,version,created_by_actor_id,created_by_actor_type,
          before_json,after_json,effect_digest,evidence_json,assumptions_json,preconditions_json,created_at_epoch,
          expires_at_epoch,create_idempotency_key,request_digest)
         VALUES(?1,?2,?3,'proposed',1,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![id,profile_id,match request.effect.operation { ScheduleOperation::Create => "schedule.create", ScheduleOperation::Update => "schedule.update" },
            actor.actor_id,actor_type_value(actor.actor_type),serde_json::to_string(&before).map_err(|error| storage("encode before payload", error))?,
            serde_json::to_string(&request.effect).map_err(|error| storage("encode effect", error))?,effect_digest,
            serde_json::to_string(&request.evidence).map_err(|error| storage("encode evidence", error))?,
            serde_json::to_string(&request.assumptions).map_err(|error| storage("encode assumptions", error))?,
            serde_json::to_string(&preconditions).map_err(|error| storage("encode preconditions", error))?,now_epoch,
            expires_at_epoch,request.idempotency_key,request_digest],
    ).map_err(|error| storage("persist proposal", error))?;
    let audit_id = audit(&transaction, &id, "created", &actor.actor_id, None, ProposalState::Proposed, now_epoch,
        &serde_json::json!({"effectDigest": effect_digest}))?;
    let proposal = into_proposal(&transaction, load_stored(&transaction, &id)?)?;
    transaction.commit().map_err(|error| storage("commit proposal creation", error))?;
    Ok(LifecycleResult { proposal, audit_ref: record_ref(RecordKind::Audit, audit_id, "v1".to_owned()), replayed: false })
}

fn maybe_expire(connection: &Connection, proposal: &mut StoredProposal, actor_id: &str, now_epoch: i64) -> Result<Option<String>, ProposalError> {
    if matches!(proposal.state, ProposalState::Proposed | ProposalState::Approved) && proposal.expires_at_epoch <= now_epoch {
        let prior = proposal.state;
        proposal.state = ProposalState::Expired;
        proposal.version += 1;
        connection.execute("UPDATE finance_proposals SET state='expired',version=version+1 WHERE id=?1", [&proposal.id])
            .map_err(|error| storage("expire proposal", error))?;
        return audit(connection, &proposal.id, "expired", actor_id, Some(prior), ProposalState::Expired, now_epoch, &serde_json::json!({})).map(Some);
    }
    Ok(None)
}

pub fn get_schedule_proposal(
    connection: &mut Connection, actor: &Actor, reference: &RecordRef, now_epoch: i64,
) -> Result<LifecycleResult, ProposalError> {
    permitted(actor, ActionClass::Read, RecordScope::Proposals)?;
    let id = local_id(reference, RecordKind::Proposal)?.to_owned();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage("begin proposal read", error))?;
    let mut stored = load_stored(&transaction, &id)?;
    let audit_id = if let Some(id) = maybe_expire(&transaction, &mut stored, &actor.actor_id, now_epoch)? { id } else {
        transaction.query_row("SELECT id FROM finance_audit_events WHERE proposal_id=?1 ORDER BY created_at_epoch DESC,id DESC LIMIT 1",
            [&id], |row| row.get(0)).map_err(|error| storage("load proposal audit", error))?
    };
    let proposal = into_proposal(&transaction, stored)?;
    transaction.commit().map_err(|error| storage("commit proposal read", error))?;
    Ok(LifecycleResult { proposal, audit_ref: record_ref(RecordKind::Audit, audit_id, "v1".to_owned()), replayed: false })
}

pub fn reject_schedule_proposal(
    connection: &mut Connection, actor: &Actor, request: &ProposalTransitionRequest, now_epoch: i64,
) -> Result<LifecycleResult, ProposalError> {
    permitted(actor, ActionClass::Propose, RecordScope::Proposals)?;
    let reason = request.reason.as_deref().map(str::trim).filter(|value| !value.is_empty())
        .ok_or_else(|| ProposalError::InvalidRequest("rejection reason is required".to_owned()))?;
    let id = local_id(&request.proposal_ref, RecordKind::Proposal)?.to_owned();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage("begin proposal rejection", error))?;
    let mut stored = load_stored(&transaction, &id)?;
    if maybe_expire(&transaction, &mut stored, &actor.actor_id, now_epoch)?.is_some() {
        transaction.commit().map_err(|error| storage("commit proposal expiry", error))?;
        return Err(ProposalError::Expired);
    }
    if format!("v{}", stored.version) != request.expected_proposal_version {
        return Err(ProposalError::StateConflict("proposal version changed before rejection".to_owned()));
    }
    if !matches!(stored.state, ProposalState::Proposed | ProposalState::Approved) {
        return Err(ProposalError::StateConflict("proposal can no longer be rejected".to_owned()));
    }
    let prior = stored.state;
    transaction.execute("UPDATE finance_proposals SET state='rejected',version=version+1 WHERE id=?1", [&id])
        .map_err(|error| storage("reject proposal", error))?;
    let audit_id = audit(&transaction, &id, "rejected", &actor.actor_id, Some(prior), ProposalState::Rejected, now_epoch,
        &serde_json::json!({"reason": reason, "idempotencyKey": request.idempotency_key}))?;
    let proposal = into_proposal(&transaction, load_stored(&transaction, &id)?)?;
    transaction.commit().map_err(|error| storage("commit proposal rejection", error))?;
    Ok(LifecycleResult { proposal, audit_ref: record_ref(RecordKind::Audit, audit_id, "v1".to_owned()), replayed: false })
}

pub fn confirm_schedule_proposal(
    connection: &mut Connection, actor: &Actor, profile_id: &str, reference: &RecordRef,
    expected_version: &str, now_epoch: i64,
) -> Result<ConfirmationArtifact, ProposalError> {
    permitted(actor, ActionClass::Confirm, RecordScope::Proposals)?;
    if actor.actor_type != ActorType::User {
        return Err(ProposalError::Authorization("only the native user confirmation path may approve a proposal".to_owned()));
    }
    let id = local_id(reference, RecordKind::Proposal)?.to_owned();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage("begin proposal confirmation", error))?;
    let mut stored = load_stored(&transaction, &id)?;
    if stored.profile_id != profile_id { return Err(ProposalError::ConfirmationRequired); }
    if maybe_expire(&transaction, &mut stored, &actor.actor_id, now_epoch)?.is_some() {
        transaction.commit().map_err(|error| storage("commit proposal expiry", error))?;
        return Err(ProposalError::Expired);
    }
    if format!("v{}", stored.version) != expected_version || stored.state != ProposalState::Proposed {
        return Err(ProposalError::StateConflict("proposal changed before confirmation".to_owned()));
    }
    transaction.execute("UPDATE finance_proposals SET state='approved',version=version+1 WHERE id=?1", [&id])
        .map_err(|error| storage("approve proposal", error))?;
    stored = load_stored(&transaction, &id)?;
    let artifact_id = random_id("confirm");
    let expires_at_epoch = now_epoch + CONFIRMATION_LIFETIME_SECONDS;
    transaction.execute(
        "INSERT INTO finance_confirmation_artifacts(artifact_id,proposal_id,proposal_version,profile_id,actor_id,effect_digest,confirmed_at_epoch,expires_at_epoch,consumed_at_epoch)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL)
         ON CONFLICT(proposal_id) DO UPDATE SET artifact_id=excluded.artifact_id,proposal_version=excluded.proposal_version,
           profile_id=excluded.profile_id,actor_id=excluded.actor_id,effect_digest=excluded.effect_digest,
           confirmed_at_epoch=excluded.confirmed_at_epoch,expires_at_epoch=excluded.expires_at_epoch,consumed_at_epoch=NULL",
        params![artifact_id,id,stored.version,profile_id,actor.actor_id,stored.effect_digest,now_epoch,expires_at_epoch],
    ).map_err(|error| storage("persist confirmation artifact", error))?;
    audit(&transaction, &id, "approved", &actor.actor_id, Some(ProposalState::Proposed), ProposalState::Approved, now_epoch,
        &serde_json::json!({"artifactId": artifact_id, "expiresAtEpoch": expires_at_epoch}))?;
    let artifact = ConfirmationArtifact {
        artifact_id, proposal_ref: proposal_ref(&stored), proposal_version: format!("v{}", stored.version),
        profile_ref: record_ref(RecordKind::Profile, profile_id.to_owned(), content_version(&[profile_id])),
        actor_id: actor.actor_id.clone(), effect_digest: stored.effect_digest,
        confirmed_at: timestamp(&transaction, now_epoch)?, expires_at: timestamp(&transaction, expires_at_epoch)?,
    };
    transaction.commit().map_err(|error| storage("commit proposal confirmation", error))?;
    Ok(artifact)
}

fn transition_terminal(
    connection: &Connection, stored: &mut StoredProposal, actor_id: &str, state: ProposalState,
    action: &str, message: Option<&str>, now_epoch: i64,
) -> Result<String, ProposalError> {
    let prior = stored.state;
    stored.state = state;
    stored.version += 1;
    stored.last_error = message.map(str::to_owned);
    connection.execute("UPDATE finance_proposals SET state=?1,version=version+1,last_error=?2 WHERE id=?3",
        params![state.database_value(), message, stored.id]).map_err(|error| storage("transition proposal", error))?;
    audit(connection, &stored.id, action, actor_id, Some(prior), state, now_epoch,
        &serde_json::json!({"message": message}))
}

pub fn execute_confirmed_schedule_proposal(
    connection: &mut Connection, actor: &Actor, profile_id: &str,
    request: &ExecuteConfirmedRequest, now_epoch: i64,
) -> Result<LifecycleResult, ProposalError> {
    permitted(actor, ActionClass::Execute, RecordScope::Proposals)?;
    permitted(actor, ActionClass::Execute, RecordScope::Schedules)?;
    if request.idempotency_key.len() < 8 || request.idempotency_key.len() > 200 {
        return Err(ProposalError::InvalidRequest("execution idempotency key must contain 8 to 200 characters".to_owned()));
    }
    let id = local_id(&request.proposal_ref, RecordKind::Proposal)?.to_owned();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| storage("begin proposal execution", error))?;
    if let Some((prior_proposal, schedule_id, audit_id)) = transaction.query_row(
        "SELECT proposal_id,result_schedule_id,audit_id FROM finance_execution_outcomes WHERE idempotency_key=?1",
        [&request.idempotency_key], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?))
    ).optional().map_err(|error| storage("load execution idempotency outcome", error))? {
        if prior_proposal != id { return Err(ProposalError::IdempotencyConflict); }
        let stored = load_stored(&transaction, &id)?;
        if stored.result_schedule_id.as_deref() != Some(schedule_id.as_str()) { return Err(ProposalError::IdempotencyConflict); }
        let proposal = into_proposal(&transaction, stored)?;
        transaction.commit().map_err(|error| storage("commit replayed execution read", error))?;
        return Ok(LifecycleResult { proposal, audit_ref: record_ref(RecordKind::Audit, audit_id, "v1".to_owned()), replayed: true });
    }
    let mut stored = load_stored(&transaction, &id)?;
    if stored.profile_id != profile_id || format!("v{}", stored.version) != request.expected_proposal_version
        || stored.state != ProposalState::Approved {
        return Err(ProposalError::StateConflict("proposal is not the approved version requested for execution".to_owned()));
    }
    if maybe_expire(&transaction, &mut stored, &actor.actor_id, now_epoch)?.is_some() {
        transaction.commit().map_err(|error| storage("commit proposal expiry", error))?;
        return Err(ProposalError::Expired);
    }
    let artifact = transaction.query_row(
        "SELECT proposal_version,profile_id,actor_id,effect_digest,confirmed_at_epoch,expires_at_epoch,consumed_at_epoch
         FROM finance_confirmation_artifacts WHERE artifact_id=?1 AND proposal_id=?2",
        params![request.confirmation_artifact.artifact_id,id],
        |row| Ok((row.get::<_, i64>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,row.get::<_, i64>(5)?,row.get::<_, Option<i64>>(6)?))
    ).optional().map_err(|error| storage("load confirmation artifact", error))?.ok_or(ProposalError::ConfirmationRequired)?;
    let confirmed_at = timestamp(&transaction, artifact.4)?;
    let artifact_expires_at = timestamp(&transaction, artifact.5)?;
    if artifact.0 != stored.version || artifact.1 != profile_id || artifact.2 != request.confirmation_artifact.actor_id
        || artifact.3 != stored.effect_digest || artifact.5 <= now_epoch || artifact.6.is_some()
        || request.confirmation_artifact.proposal_version != format!("v{}", stored.version)
        || request.confirmation_artifact.effect_digest != stored.effect_digest
        || request.confirmation_artifact.proposal_ref.id != request.proposal_ref.id
        || request.confirmation_artifact.proposal_ref.version != request.expected_proposal_version
        || request.confirmation_artifact.profile_ref.id != format!("money-map:profile:{profile_id}") {
        return Err(ProposalError::ConfirmationRequired);
    }
    if request.confirmation_artifact.confirmed_at != confirmed_at || request.confirmation_artifact.expires_at != artifact_expires_at {
        return Err(ProposalError::ConfirmationRequired);
    }
    let mut stale = Vec::new();
    for precondition in &stored.preconditions {
        if current_record_version(&transaction, &precondition.record_ref)?
            .as_deref() != Some(precondition.expected_version.as_str()) {
            stale.push(precondition.record_ref.clone());
        }
    }
    if !stale.is_empty() {
        transition_terminal(&transaction, &mut stored, &actor.actor_id, ProposalState::Stale, "stale", None, now_epoch)?;
        transaction.commit().map_err(|error| storage("commit stale proposal", error))?;
        return Err(ProposalError::Stale(stale));
    }
    let account_id = local_id(&stored.effect.account_ref, RecordKind::Account)?.to_owned();
    let signed_amount = match stored.effect.direction { Direction::Inflow => stored.effect.amount.amount_cents, Direction::Outflow => -stored.effect.amount.amount_cents };
    let schedule_id = match stored.effect.operation {
        ScheduleOperation::Create => random_id("schedule"),
        ScheduleOperation::Update => local_id(stored.effect.target_schedule_ref.as_ref().ok_or_else(||
            ProposalError::InvalidRequest("update target is missing".to_owned()))?, RecordKind::Schedule)?.to_owned(),
    };
    let mutation = match stored.effect.operation {
        ScheduleOperation::Create => transaction.execute(
            "INSERT INTO scheduled_transactions(id,account_id,start_date,end_date,description,amount_cents,recurrence)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![schedule_id,account_id,stored.effect.start_date,stored.effect.end_date,stored.effect.name.trim(),
                signed_amount,stored.effect.cadence.database_value()]),
        ScheduleOperation::Update => transaction.execute(
            "UPDATE scheduled_transactions SET account_id=?1,start_date=?2,end_date=?3,description=?4,amount_cents=?5,recurrence=?6 WHERE id=?7",
            params![account_id,stored.effect.start_date,stored.effect.end_date,stored.effect.name.trim(),signed_amount,
                stored.effect.cadence.database_value(),schedule_id]),
    };
    if let Err(error) = mutation {
        let message = error.to_string();
        transition_terminal(&transaction, &mut stored, &actor.actor_id, ProposalState::Failed, "failed", Some(&message), now_epoch)?;
        transaction.commit().map_err(|commit_error| storage("commit failed execution audit", commit_error))?;
        return Err(ProposalError::ExecutionFailed(message));
    }
    if matches!(stored.effect.operation, ScheduleOperation::Update) && mutation.unwrap_or(0) != 1 {
        transition_terminal(&transaction, &mut stored, &actor.actor_id, ProposalState::Stale, "stale", Some("target schedule disappeared"), now_epoch)?;
        transaction.commit().map_err(|error| storage("commit missing update target", error))?;
        return Err(ProposalError::Stale(vec![stored.effect.target_schedule_ref.clone().unwrap()]));
    }
    transaction.execute("UPDATE finance_proposals SET state='executed',version=version+1,result_schedule_id=?1,last_error=NULL WHERE id=?2",
        params![schedule_id,id]).map_err(|error| storage("complete proposal execution", error))?;
    stored = load_stored(&transaction, &id)?;
    let audit_id = audit(&transaction, &id, "executed", &actor.actor_id, Some(ProposalState::Approved), ProposalState::Executed,
        now_epoch, &serde_json::json!({"resultScheduleId": schedule_id, "idempotencyKey": request.idempotency_key}))?;
    transaction.execute("UPDATE finance_confirmation_artifacts SET consumed_at_epoch=?1 WHERE artifact_id=?2",
        params![now_epoch,request.confirmation_artifact.artifact_id]).map_err(|error| storage("consume confirmation artifact", error))?;
    transaction.execute("INSERT INTO finance_execution_outcomes(idempotency_key,proposal_id,result_schedule_id,audit_id,created_at_epoch) VALUES(?1,?2,?3,?4,?5)",
        params![request.idempotency_key,id,schedule_id,audit_id,now_epoch]).map_err(|error| storage("persist execution outcome", error))?;
    let proposal = into_proposal(&transaction, stored)?;
    transaction.commit().map_err(|error| storage("commit proposal execution", error))?;
    Ok(LifecycleResult { proposal, audit_ref: record_ref(RecordKind::Audit, audit_id, "v1".to_owned()), replayed: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    const NOW: i64 = 1_788_768_000;
    const PROFILE: &str = "profile-test";

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE accounts(
               id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,opening_balance_cents INTEGER NOT NULL,
               reported_balance_cents INTEGER,created_at TEXT NOT NULL);
             CREATE TABLE transactions(
               id TEXT PRIMARY KEY,account_id TEXT NOT NULL,transaction_date TEXT NOT NULL,description TEXT NOT NULL,
               amount_cents INTEGER NOT NULL,category_id TEXT,notes TEXT,source TEXT NOT NULL,external_transaction_id TEXT,
               created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
             CREATE TABLE scheduled_transactions(
               id TEXT PRIMARY KEY,account_id TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,description TEXT NOT NULL,
               amount_cents INTEGER NOT NULL,recurrence TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
               last_processed_occurrence TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
             INSERT INTO accounts VALUES('checking','Primary Checking','checking',0,250000,'2026-01-01T00:00:00Z');
             INSERT INTO transactions VALUES(
               'evidence-1','checking','2026-08-11','AIDVANTAGE PAYMENT',-63729,'debt',NULL,'plaid:item-a','provider-1',
               '2026-08-12T00:00:00Z','2026-08-12T00:00:00Z');"
        ).unwrap();
        migrate(&connection).unwrap();
        connection
    }

    fn actor(actor_type: ActorType, actions: Vec<ActionClass>) -> Actor {
        Actor {
            actor_id: match actor_type { ActorType::User => "native-user", _ => "agent" }.to_owned(),
            actor_type,
            action_classes: actions,
            scopes: vec![RecordScope::Proposals, RecordScope::Schedules],
        }
    }

    fn reference(connection: &Connection, kind: RecordKind, id: &str) -> RecordRef {
        let unresolved = record_ref(kind, id.to_owned(), String::new());
        let version = current_record_version(connection, &unresolved).unwrap().unwrap();
        record_ref(kind, id.to_owned(), version)
    }

    fn request(connection: &Connection, operation: ScheduleOperation) -> CreateScheduleProposalRequest {
        let target_schedule_ref = matches!(operation, ScheduleOperation::Update)
            .then(|| reference(connection, RecordKind::Schedule, "existing-schedule"));
        CreateScheduleProposalRequest {
            effect: ScheduleEffect {
                operation,
                target_schedule_ref,
                name: "Aidvantage student loan".to_owned(),
                account_ref: reference(connection, RecordKind::Account, "checking"),
                direction: Direction::Outflow,
                amount: Money { currency: "USD".to_owned(), amount_cents: 63_729 },
                amount_policy: AmountPolicy::Fixed,
                cadence: Cadence::Monthly,
                temporal_role: TemporalRole::DueDate,
                start_date: "2026-09-11".to_owned(),
                end_date: None,
            },
            evidence: vec![EvidenceRef {
                record_ref: reference(connection, RecordKind::Transaction, "evidence-1"),
                role: EvidenceRole::Observation,
                observed_at: Some("2026-08-12T00:00:00Z".to_owned()),
            }],
            assumptions: vec!["Use the statement due date as the forecast anchor.".to_owned()],
            preconditions: Vec::new(),
            expires_at: timestamp(connection, NOW + 3600).unwrap(),
            idempotency_key: "create-request-001".to_owned(),
        }
    }

    fn create_and_confirm(connection: &mut Connection) -> (LifecycleResult, ConfirmationArtifact) {
        let create_request = request(connection, ScheduleOperation::Create);
        let created = create_schedule_proposal(
            connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE,
            &create_request,
            NOW,
        ).unwrap();
        let artifact = confirm_schedule_proposal(
            connection,
            &actor(ActorType::User, vec![ActionClass::Confirm]),
            PROFILE,
            &created.proposal.proposal_ref,
            &created.proposal.proposal_ref.version,
            NOW + 10,
        ).unwrap();
        (created, artifact)
    }

    #[test]
    fn confirmed_execution_is_atomic_and_replay_safe() {
        let mut connection = database();
        let (created, artifact) = create_and_confirm(&mut connection);
        assert_eq!(created.proposal.state, ProposalState::Proposed);
        assert!(created.proposal.before.is_none());
        assert!(created.proposal.preconditions.len() >= 2);
        let execution = ExecuteConfirmedRequest {
            proposal_ref: artifact.proposal_ref.clone(),
            expected_proposal_version: artifact.proposal_version.clone(),
            confirmation_artifact: artifact,
            idempotency_key: "execute-request-001".to_owned(),
        };
        let executed = execute_confirmed_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Execute]),
            PROFILE,
            &execution,
            NOW + 20,
        ).unwrap();
        assert_eq!(executed.proposal.state, ProposalState::Executed);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("SELECT amount_cents FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), -63_729);

        let replay = execute_confirmed_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Execute]),
            PROFILE,
            &execution,
            NOW + 30,
        ).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.proposal.result_schedule_ref, executed.proposal.result_schedule_ref);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn expiry_is_persisted_before_confirmation() {
        let mut connection = database();
        let mut expiring = request(&connection, ScheduleOperation::Create);
        expiring.expires_at = timestamp(&connection, NOW + 1).unwrap();
        let created = create_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE, &expiring, NOW,
        ).unwrap();
        let error = confirm_schedule_proposal(
            &mut connection, &actor(ActorType::User, vec![ActionClass::Confirm]), PROFILE,
            &created.proposal.proposal_ref, &created.proposal.proposal_ref.version, NOW + 2,
        ).unwrap_err();
        assert_eq!(error, ProposalError::Expired);
        assert_eq!(load_stored(&connection, local_id(&created.proposal.proposal_ref, RecordKind::Proposal).unwrap()).unwrap().state, ProposalState::Expired);
    }

    #[test]
    fn changed_evidence_marks_approved_proposal_stale() {
        let mut connection = database();
        let (_created, artifact) = create_and_confirm(&mut connection);
        connection.execute("UPDATE transactions SET description='CHANGED' WHERE id='evidence-1'", []).unwrap();
        let error = execute_confirmed_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Execute]),
            PROFILE,
            &ExecuteConfirmedRequest {
                proposal_ref: artifact.proposal_ref.clone(), expected_proposal_version: artifact.proposal_version.clone(),
                confirmation_artifact: artifact, idempotency_key: "execute-stale-001".to_owned(),
            },
            NOW + 20,
        ).unwrap_err();
        assert!(matches!(error, ProposalError::Stale(ref refs) if !refs.is_empty()));
        assert_eq!(connection.query_row("SELECT state FROM finance_proposals", [], |row| row.get::<_, String>(0)).unwrap(), "stale");
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn non_user_actor_cannot_create_confirmation_artifact() {
        let mut connection = database();
        let create_request = request(&connection, ScheduleOperation::Create);
        let created = create_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE, &create_request, NOW,
        ).unwrap();
        let error = confirm_schedule_proposal(
            &mut connection,
            &actor(ActorType::LocalMcpClient, vec![ActionClass::Confirm]),
            PROFILE, &created.proposal.proposal_ref, &created.proposal.proposal_ref.version, NOW + 10,
        ).unwrap_err();
        assert!(matches!(error, ProposalError::Authorization(_)));
        assert_eq!(load_stored(&connection, local_id(&created.proposal.proposal_ref, RecordKind::Proposal).unwrap()).unwrap().state, ProposalState::Proposed);
    }

    #[test]
    fn failed_schedule_insert_rolls_back_effect_and_records_failure() {
        let mut connection = database();
        let (_created, artifact) = create_and_confirm(&mut connection);
        connection.execute_batch("CREATE TRIGGER fail_schedule BEFORE INSERT ON scheduled_transactions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        let error = execute_confirmed_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Execute]),
            PROFILE,
            &ExecuteConfirmedRequest {
                proposal_ref: artifact.proposal_ref.clone(), expected_proposal_version: artifact.proposal_version.clone(),
                confirmation_artifact: artifact, idempotency_key: "execute-failure-001".to_owned(),
            }, NOW + 20,
        ).unwrap_err();
        assert!(matches!(error, ProposalError::ExecutionFailed(_)));
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("SELECT state FROM finance_proposals", [], |row| row.get::<_, String>(0)).unwrap(), "failed");
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM finance_audit_events WHERE action='failed'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn update_proposal_preserves_exact_before_and_updates_same_schedule() {
        let mut connection = database();
        connection.execute(
            "INSERT INTO scheduled_transactions VALUES('existing-schedule','checking','2026-08-11',NULL,'Old name',-50000,'monthly',1,NULL,'2026-01-01T00:00:00Z')", [],
        ).unwrap();
        let update_request = request(&connection, ScheduleOperation::Update);
        let created = create_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE, &update_request, NOW,
        ).unwrap();
        assert_eq!(created.proposal.before.as_ref().unwrap().name, "Old name");
        let artifact = confirm_schedule_proposal(
            &mut connection, &actor(ActorType::User, vec![ActionClass::Confirm]), PROFILE,
            &created.proposal.proposal_ref, &created.proposal.proposal_ref.version, NOW + 10,
        ).unwrap();
        let result = execute_confirmed_schedule_proposal(
            &mut connection, &actor(ActorType::InAppHarness, vec![ActionClass::Execute]), PROFILE,
            &ExecuteConfirmedRequest { proposal_ref: artifact.proposal_ref.clone(), expected_proposal_version: artifact.proposal_version.clone(),
                confirmation_artifact: artifact, idempotency_key: "execute-update-001".to_owned() }, NOW + 20,
        ).unwrap();
        assert_eq!(result.proposal.result_schedule_ref.unwrap().id, "money-map:schedule:existing-schedule");
        assert_eq!(connection.query_row("SELECT description FROM scheduled_transactions WHERE id='existing-schedule'", [], |row| row.get::<_, String>(0)).unwrap(), "Aidvantage student loan");
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn create_idempotency_and_rejection_are_durable() {
        let mut connection = database();
        let create_request = request(&connection, ScheduleOperation::Create);
        let first = create_schedule_proposal(
            &mut connection, &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE, &create_request, NOW,
        ).unwrap();
        let replay = create_schedule_proposal(
            &mut connection, &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE, &create_request, NOW,
        ).unwrap();
        assert!(replay.replayed);
        assert_eq!(first.proposal.proposal_ref, replay.proposal.proposal_ref);

        let rejected = reject_schedule_proposal(
            &mut connection,
            &actor(ActorType::InAppHarness, vec![ActionClass::Propose]),
            &ProposalTransitionRequest {
                proposal_ref: first.proposal.proposal_ref.clone(),
                expected_proposal_version: first.proposal.proposal_ref.version.clone(),
                idempotency_key: "reject-request-001".to_owned(),
                reason: Some("User chose a different date.".to_owned()),
            }, NOW + 10,
        ).unwrap();
        assert_eq!(rejected.proposal.state, ProposalState::Rejected);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM finance_audit_events WHERE action='rejected'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn fabricated_confirmation_cannot_bypass_native_approval() {
        let mut connection = database();
        let create_request = request(&connection, ScheduleOperation::Create);
        let created = create_schedule_proposal(
            &mut connection, &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
            PROFILE, &create_request, NOW,
        ).unwrap();
        let fake = ConfirmationArtifact {
            artifact_id: "confirm_fabricated000000000000000".to_owned(),
            proposal_ref: created.proposal.proposal_ref.clone(),
            proposal_version: created.proposal.proposal_ref.version.clone(),
            profile_ref: record_ref(RecordKind::Profile, PROFILE.to_owned(), content_version(&[PROFILE])),
            actor_id: "native-user".to_owned(),
            effect_digest: created.proposal.effect_digest.clone(),
            confirmed_at: timestamp(&connection, NOW).unwrap(),
            expires_at: timestamp(&connection, NOW + 120).unwrap(),
        };
        let error = execute_confirmed_schedule_proposal(
            &mut connection, &actor(ActorType::InAppHarness, vec![ActionClass::Execute]), PROFILE,
            &ExecuteConfirmedRequest {
                proposal_ref: created.proposal.proposal_ref.clone(),
                expected_proposal_version: created.proposal.proposal_ref.version.clone(),
                confirmation_artifact: fake,
                idempotency_key: "execute-fake-001".to_owned(),
            }, NOW + 10,
        ).unwrap_err();
        assert!(matches!(error, ProposalError::StateConflict(_) | ProposalError::ConfirmationRequired));
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM scheduled_transactions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn concurrent_confirmation_has_exactly_one_winner() {
        let path = std::env::temp_dir().join(format!("money-map-proposal-confirm-{}.db", random_id("test")));
        {
            let mut setup = Connection::open(&path).unwrap();
            setup.execute_batch(
                "CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT,type TEXT,opening_balance_cents INTEGER,reported_balance_cents INTEGER,created_at TEXT);
                 CREATE TABLE transactions(id TEXT PRIMARY KEY,account_id TEXT,transaction_date TEXT,description TEXT,amount_cents INTEGER,category_id TEXT,notes TEXT,source TEXT,external_transaction_id TEXT,created_at TEXT,updated_at TEXT);
                 CREATE TABLE scheduled_transactions(id TEXT PRIMARY KEY,account_id TEXT,start_date TEXT,end_date TEXT,description TEXT,amount_cents INTEGER,recurrence TEXT,active INTEGER,last_processed_occurrence TEXT,created_at TEXT);
                 INSERT INTO accounts VALUES('checking','Primary Checking','checking',0,250000,'2026-01-01T00:00:00Z');
                 INSERT INTO transactions VALUES('evidence-1','checking','2026-08-11','AIDVANTAGE PAYMENT',-63729,'debt',NULL,'plaid:item-a','provider-1','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z');"
            ).unwrap();
            migrate(&setup).unwrap();
            let create_request = request(&setup, ScheduleOperation::Create);
            let _ = create_schedule_proposal(
                &mut setup, &actor(ActorType::InAppHarness, vec![ActionClass::Read, ActionClass::Propose]),
                PROFILE, &create_request, NOW,
            ).unwrap();
        }
        let reference = {
            let connection = Connection::open(&path).unwrap();
            let stored = connection.query_row("SELECT id FROM finance_proposals", [], |row| row.get::<_, String>(0)).unwrap();
            record_ref(RecordKind::Proposal, stored, "v1".to_owned())
        };
        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let reference = reference.clone();
            workers.push(std::thread::spawn(move || {
                let mut connection = Connection::open(path).unwrap();
                connection.busy_timeout(Duration::from_secs(5)).unwrap();
                barrier.wait();
                confirm_schedule_proposal(
                    &mut connection, &actor(ActorType::User, vec![ActionClass::Confirm]), PROFILE,
                    &reference, "v1", NOW + 10,
                )
            }));
        }
        let results = workers.into_iter().map(|worker| worker.join().unwrap()).collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM finance_confirmation_artifacts", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
}
