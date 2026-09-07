import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, LoaderCircle, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./recurring-review.css";

type RecordKind = "transaction" | "schedule" | "account" | "category" | "proposal" | "audit" | "profile";
type RecordRef = { kind: RecordKind; id: string; version: string };
type RecurringObservation = {
  transactionRef: RecordRef;
  transactionDate: string;
  amountCents: number;
  description: string;
  source: string;
};
type RecurringCandidate = {
  partyKey: string;
  displayName: string;
  accountRef: RecordRef;
  accountName: string;
  recurrence: string;
  nextExpectedDate: string | null;
  confidenceBasisPoints: number;
  amountDistribution: { minimumCents: number; maximumCents: number; medianCents: number; currency: string };
  observedIntervalDays: number[];
  candidateTemporalRoles: string[];
  evidence: RecurringObservation[];
  matchingScheduleRefs: RecordRef[];
  explanation: string;
};
type RecurringDetectResult = {
  candidates: RecurringCandidate[];
  scannedRecords: number;
  truncated: boolean;
  warnings: string[];
};
type ScheduleEffect = {
  operation: "schedule.create";
  targetScheduleRef: null;
  name: string;
  accountRef: RecordRef;
  direction: "inflow" | "outflow";
  amount: { currency: "USD"; amountCents: number };
  amountPolicy: "fixed" | "estimate" | "statement_amount" | "variable";
  cadence: "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  temporalRole: "due_date" | "planned_date" | "autopay_date" | "expected_settlement_date";
  startDate: string;
  endDate: string | null;
};
type EvidenceRef = { ref: RecordRef; role: "observation"; observedAt: null };
type ScheduleProposal = {
  proposalRef: RecordRef;
  state: "proposed" | "approved" | "rejected" | "expired" | "stale" | "executed" | "failed";
  before: null;
  effect: ScheduleEffect;
  effectDigest: string;
  evidence: EvidenceRef[];
  assumptions: string[];
  createdAt: string;
  expiresAt: string;
  resultScheduleRef: RecordRef | null;
  lastError: string | null;
};
type LifecycleResult = { proposal: ScheduleProposal; auditRef: RecordRef; replayed: boolean };
type ConfirmationArtifact = {
  artifactId: string;
  proposalRef: RecordRef;
  proposalVersion: string;
  profileRef: RecordRef;
  actorId: string;
  effectDigest: string;
  confirmedAt: string;
  expiresAt: string;
};
type Draft = {
  name: string;
  amount: string;
  direction: ScheduleEffect["direction"];
  cadence: ScheduleEffect["cadence"];
  startDate: string;
  amountPolicy: ScheduleEffect["amountPolicy"];
  temporalRole: ScheduleEffect["temporalRole"];
};

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = (cents: number) => dollars.format(cents / 100);
const cadenceLabel = (value: string) => ({ daily: "daily", weekly: "weekly", biweekly: "every two weeks", monthly: "monthly", quarterly: "quarterly", yearly: "yearly", annual: "yearly" }[value] ?? value);
const proposalLifetimeMs = 15 * 60 * 1_000;
const latestEvidenceDate = (candidate: RecurringCandidate) => candidate.evidence.reduce((latest, item) => item.transactionDate > latest ? item.transactionDate : latest, "");

function explainFailure(reason: unknown) {
  const message = String(reason);
  const normalized = message.toLowerCase();
  if (normalized.includes("expired")) return "This review expired before it was completed. Refresh the candidates and review a new draft.";
  if (normalized.includes("stale") || normalized.includes("precondition")) return "The account or cited transactions changed during review. Nothing was added. Refresh and review the current evidence.";
  if (normalized.includes("confirmation")) return "The confirmation was missing, changed, or expired. Nothing was added; review the draft again.";
  if (normalized.includes("state") || normalized.includes("version")) return "This proposal changed in another action. Refresh before trying again.";
  return message;
}

function initialDraft(candidate: RecurringCandidate): Draft {
  const cadence = candidate.recurrence === "yearly" ? "annual" : candidate.recurrence as Draft["cadence"];
  return {
    name: candidate.displayName,
    amount: (Math.abs(candidate.amountDistribution.medianCents) / 100).toFixed(2),
    direction: candidate.amountDistribution.medianCents < 0 ? "outflow" : "inflow",
    cadence,
    startDate: candidate.nextExpectedDate ?? "",
    amountPolicy: candidate.amountDistribution.minimumCents === candidate.amountDistribution.maximumCents ? "fixed" : "estimate",
    temporalRole: "expected_settlement_date",
  };
}

function confidenceLabel(basisPoints: number) {
  if (basisPoints >= 8000) return "High confidence";
  if (basisPoints >= 6000) return "Medium confidence";
  return "Low confidence";
}

export function RecurringReview({ onExecuted }: { onExecuted: () => void }) {
  const [result, setResult] = useState<RecurringDetectResult | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<RecurringCandidate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [proposal, setProposal] = useState<LifecycleResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setResult(await invoke<RecurringDetectResult>("finance_recurring_detect", { input: { accountIds: [], party: null, dateFrom: null, dateTo: null, minimumOccurrences: 2, scanLimit: 500, maximumCandidates: 24 } }));
    } catch (reason) { setError(explainFailure(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const candidates = useMemo(() => result?.candidates.filter(candidate => !dismissed.has(`${candidate.accountRef.id}:${candidate.partyKey}`)) ?? [], [dismissed, result]);
  function open(candidate: RecurringCandidate) { setSelected(candidate); setDraft(initialDraft(candidate)); setProposal(null); setError(null); }
  function close() { if (busy) return; setSelected(null); setDraft(null); setProposal(null); setError(null); }
  function dismiss(candidate: RecurringCandidate) {
    setDismissed(current => new Set(current).add(`${candidate.accountRef.id}:${candidate.partyKey}`));
    setNotice(`${candidate.displayName} dismissed for this session.`);
  }

  async function createProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft) return;
    const amountCents = Math.round(Number(draft.amount) * 100);
    if (!draft.startDate || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      setError("Enter a positive amount and a start date before creating the proposal."); return;
    }
    const effect: ScheduleEffect = {
      operation: "schedule.create", targetScheduleRef: null, name: draft.name.trim(), accountRef: selected.accountRef,
      direction: draft.direction, amount: { currency: "USD", amountCents }, amountPolicy: draft.amountPolicy,
      cadence: draft.cadence, temporalRole: draft.temporalRole, startDate: draft.startDate, endDate: null,
    };
    const assumptions = [
      `Cadence inferred from ${selected.evidence.length} posted settlement observations.`,
      draft.temporalRole === "expected_settlement_date" ? "The start date is an expected settlement date; no statement due-date evidence was supplied." : `The user corrected the date meaning to ${draft.temporalRole.replaceAll("_", " ")}.`,
      draft.amountPolicy === "fixed" ? "The reviewed amount is expected to repeat exactly." : "The reviewed amount is an estimate and may vary between occurrences.",
    ];
    setBusy(true); setError(null);
    try {
      const created = await invoke<LifecycleResult>("finance_proposals_create_schedule", { input: {
        effect,
        evidence: selected.evidence.map(item => ({ ref: item.transactionRef, role: "observation", observedAt: null })),
        assumptions,
        preconditions: [],
        expiresAt: new Date(Date.now() + proposalLifetimeMs).toISOString(),
        idempotencyKey: `native-review:${selected.partyKey}:${Date.now()}`,
      } });
      setProposal(created);
    } catch (reason) { setError(explainFailure(reason)); }
    finally { setBusy(false); }
  }

  async function rejectProposal() {
    if (!proposal) return;
    setBusy(true); setError(null);
    try {
      await invoke("finance_proposals_reject", { input: {
        proposalRef: proposal.proposal.proposalRef,
        expectedProposalVersion: proposal.proposal.proposalRef.version,
        idempotencyKey: `native-reject:${Date.now()}`,
        reason: "Rejected in native recurring-candidate review",
      } });
      if (selected) dismiss(selected);
      close();
    } catch (reason) { setError(explainFailure(reason)); }
    finally { setBusy(false); }
  }

  async function confirmAndExecute() {
    if (!proposal) return;
    setBusy(true); setError(null);
    try {
      const artifact = await invoke<ConfirmationArtifact>("finance_proposals_confirm_native", { input: {
        proposalRef: proposal.proposal.proposalRef,
        expectedProposalVersion: proposal.proposal.proposalRef.version,
      } });
      const executed = await invoke<LifecycleResult>("finance_proposals_execute_confirmed", { input: {
        proposalRef: artifact.proposalRef,
        expectedProposalVersion: artifact.proposalVersion,
        confirmationArtifact: artifact,
        idempotencyKey: `native-execute:${artifact.artifactId}`,
      } });
      setNotice(`${executed.proposal.effect.name} was added to Scheduled transactions.`);
      if (selected) setDismissed(current => new Set(current).add(`${selected.accountRef.id}:${selected.partyKey}`));
      setSelected(null); setDraft(null); setProposal(null); onExecuted();
    } catch (reason) { setError(explainFailure(reason)); }
    finally { setBusy(false); }
  }

  return <section className="widget recurring-review" aria-labelledby="recurring-review-title">
    <header className="widget-header"><div><h2 id="recurring-review-title">Recurring review</h2><small>Posted transactions with a repeated settlement pattern</small></div><button className="icon-action" aria-label="Refresh recurring candidates" disabled={loading || busy} onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" /></button></header>
    {notice ? <p className="recurring-notice" role="status">{notice}</p> : null}
    {result?.truncated || result?.warnings.length ? <p className="recurring-warning" role="status">Results are bounded for a responsive review. {result.warnings.join(" ")}</p> : null}
    {loading ? <p className="recurring-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /> Reviewing posted transactions…</p> : null}
    {!loading && error && !selected ? <div className="recurring-state recurring-error" role="alert"><span>{error}</span><button onClick={() => void load()}>Try again</button></div> : null}
    {!loading && !error && candidates.length === 0 ? <p className="recurring-state">No missing recurring schedules found in the current local evidence.</p> : null}
    {!loading && candidates.length > 0 ? <div className="recurring-candidates">{candidates.map(candidate => {
      const key = `${candidate.accountRef.id}:${candidate.partyKey}`;
      const hasMatch = candidate.matchingScheduleRefs.length > 0;
      const canDraft = Boolean(candidate.nextExpectedDate && ["weekly", "biweekly", "monthly", "quarterly", "yearly"].includes(candidate.recurrence));
      return <article className="recurring-candidate" key={key}>
        <div className="recurring-summary"><div><strong>{candidate.displayName}</strong><small>{candidate.accountName} · {cadenceLabel(candidate.recurrence)} · evidence through {latestEvidenceDate(candidate) || "unknown"}</small></div><span className={`candidate-match ${hasMatch ? "matched" : "missing"}`}>{hasMatch ? "Existing schedule match" : "Missing schedule"}</span></div>
        <div className="candidate-metrics"><span><small>Typical amount</small><strong>{formatMoney(candidate.amountDistribution.medianCents)}</strong></span><span><small>Observed range</small><strong>{formatMoney(candidate.amountDistribution.minimumCents)}–{formatMoney(candidate.amountDistribution.maximumCents)}</strong></span><span><small>Expected next</small><strong>{candidate.nextExpectedDate ?? "Pattern unclear"}</strong></span><span><small>Confidence</small><strong>{confidenceLabel(candidate.confidenceBasisPoints)} · {(candidate.confidenceBasisPoints / 100).toFixed(0)}%</strong></span></div>
        <details className="candidate-evidence"><summary>Why Money Map flagged this <ChevronDown aria-hidden="true" /></summary><p>{candidate.explanation}</p>{candidate.evidence.map(item => <div key={item.transactionRef.id}><span>{item.transactionDate} · {item.description} · {item.source}</span><strong>{formatMoney(item.amountCents)}</strong></div>)}</details>
        <footer><button onClick={() => dismiss(candidate)}><X aria-hidden="true" />Dismiss</button><button disabled={!canDraft || hasMatch} onClick={() => open(candidate)}><Pencil aria-hidden="true" />Correct details</button><button className="primary-action" disabled={!canDraft || hasMatch} onClick={() => open(candidate)}><Plus aria-hidden="true" />Review draft</button></footer>
        {!canDraft ? <p className="candidate-caveat">This pattern is too irregular to draft safely. Review the evidence or create a schedule manually.</p> : null}
      </article>;
    })}</div> : null}

    {selected && draft ? <div className="dialog-backdrop"><section className="dialog recurring-dialog" role="dialog" aria-modal="true" aria-labelledby="recurring-dialog-title">
      <header><div><p className="eyebrow">{proposal ? "EXACT CONFIRMATION" : "DRAFT SCHEDULE"}</p><h2 id="recurring-dialog-title">{selected.displayName}</h2></div><button aria-label="Close recurring review" disabled={busy} onClick={close}>×</button></header>
      {!proposal ? <form onSubmit={createProposal}>
        <p className="review-explanation">Correct anything the transaction pattern inferred incorrectly. This step creates an inert proposal; it does not change Scheduled transactions.</p>
        <label>Description<input required autoFocus value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <div className="review-grid"><label>Amount<input required type="number" min="0.01" step="0.01" value={draft.amount} onChange={event => setDraft({ ...draft, amount: event.target.value })} /></label><label>Direction<select value={draft.direction} onChange={event => setDraft({ ...draft, direction: event.target.value as Draft["direction"] })}><option value="outflow">Money out</option><option value="inflow">Money in</option></select></label></div>
        <div className="review-grid"><label>Repeats<select value={draft.cadence} onChange={event => setDraft({ ...draft, cadence: event.target.value as Draft["cadence"] })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Yearly</option></select></label><label>Starting<input required type="date" value={draft.startDate} onChange={event => setDraft({ ...draft, startDate: event.target.value })} /></label></div>
        <div className="review-grid"><label>Amount meaning<select value={draft.amountPolicy} onChange={event => setDraft({ ...draft, amountPolicy: event.target.value as Draft["amountPolicy"] })}><option value="fixed">Fixed</option><option value="estimate">Estimate</option><option value="variable">Variable</option><option value="statement_amount">Statement amount</option></select></label><label>Date meaning<select value={draft.temporalRole} onChange={event => setDraft({ ...draft, temporalRole: event.target.value as Draft["temporalRole"] })}><option value="expected_settlement_date">Expected settlement</option><option value="planned_date">Planned date</option><option value="due_date">Due date</option><option value="autopay_date">Autopay date</option></select></label></div>
        <div className="review-evidence"><strong>Affected evidence</strong>{selected.evidence.map(item => <div key={item.transactionRef.id}><span>{item.transactionDate} · {item.description} · {item.source}</span><strong>{formatMoney(item.amountCents)}</strong></div>)}</div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="primary-action" disabled={busy} type="submit">{busy ? "Creating proposal…" : "Review exact proposal"}</button></footer>
      </form> : <div className="exact-proposal">
        <p className="review-explanation">Confirming will add exactly this schedule. Money Map will recheck every cited record before writing anything.</p>
        <dl><div><dt>Description</dt><dd>{proposal.proposal.effect.name}</dd></div><div><dt>Account</dt><dd>{selected.accountName}</dd></div><div><dt>Amount</dt><dd>{proposal.proposal.effect.direction === "outflow" ? "−" : "+"}{formatMoney(proposal.proposal.effect.amount.amountCents)}</dd></div><div><dt>Cadence</dt><dd>{cadenceLabel(proposal.proposal.effect.cadence)}</dd></div><div><dt>Start date</dt><dd>{proposal.proposal.effect.startDate}</dd></div><div><dt>Amount meaning</dt><dd>{proposal.proposal.effect.amountPolicy.replaceAll("_", " ")}</dd></div><div><dt>Date meaning</dt><dd>{proposal.proposal.effect.temporalRole.replaceAll("_", " ")}</dd></div><div><dt>Proposal expires</dt><dd>{new Date(proposal.proposal.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</dd></div></dl>
        <div className="review-evidence"><strong>{selected.evidence.length} cited transactions</strong>{selected.evidence.map(item => <div key={item.transactionRef.id}><span>{item.transactionDate} · {item.description} · {item.source}</span><strong>{formatMoney(item.amountCents)}</strong></div>)}</div>
        <div className="proposal-digest"><small>Exact effect fingerprint</small><code>{proposal.proposal.effectDigest}</code></div>
        {proposal.proposal.assumptions.map(assumption => <p className="proposal-assumption" key={assumption}>{assumption}</p>)}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <footer><button disabled={busy} onClick={() => void rejectProposal()}>{busy ? "Working…" : "Reject"}</button><button className="primary-action" disabled={busy} onClick={() => void confirmAndExecute()}>{busy ? <><LoaderCircle className="spin" aria-hidden="true" /> Rechecking…</> : <><Check aria-hidden="true" /> Confirm and add schedule</>}</button></footer>
      </div>}
    </section></div> : null}
  </section>;
}
