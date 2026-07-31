using FamilyFinance.Domain;

namespace FamilyFinance.Data;

/// <summary>
/// A ledger entry together with its resolved display names and, when applicable,
/// the immutable schedule occurrence that created it.
/// </summary>
public sealed record LedgerTransaction(
    Transaction Transaction,
    string AccountName,
    string? CategoryName,
    ScheduledTransactionPosting? ScheduledPosting);
