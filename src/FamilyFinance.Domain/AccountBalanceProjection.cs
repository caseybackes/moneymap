namespace FamilyFinance.Domain;

/// <summary>A deterministic balance projection for one account at the end of a calendar day.</summary>
public sealed record AccountBalanceProjection(
    Guid AccountId,
    DateOnly ThroughDate,
    Money LedgerBalance,
    Money ScheduledChange,
    Money ProjectedBalance);

public static class AccountBalanceProjector
{
    /// <summary>
    /// Combines posted ledger entries and non-posting scheduled occurrences for one account through an inclusive date.
    /// Scheduled occurrences are never written to, or treated as, ledger transactions by this calculation.
    /// </summary>
    public static AccountBalanceProjection Calculate(
        Account account,
        IEnumerable<Transaction> transactions,
        IEnumerable<ScheduledTransactionOccurrence> scheduledOccurrences,
        DateOnly throughDate)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(transactions);
        ArgumentNullException.ThrowIfNull(scheduledOccurrences);

        var ledgerBalance = new Money(account.OpeningBalance.Amount + transactions
            .Where(transaction => transaction.AccountId == account.Id && transaction.Date <= throughDate)
            .Sum(transaction => transaction.Amount.Amount));
        var scheduledChange = new Money(scheduledOccurrences
            .Where(occurrence => occurrence.Schedule.AccountId == account.Id && occurrence.Date <= throughDate)
            .Sum(occurrence => occurrence.Schedule.Amount.Amount));

        return new AccountBalanceProjection(account.Id, throughDate, ledgerBalance, scheduledChange, ledgerBalance + scheduledChange);
    }
}
