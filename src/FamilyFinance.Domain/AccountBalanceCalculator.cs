namespace FamilyFinance.Domain;

public static class AccountBalanceCalculator
{
    public static Money Calculate(Account account, IEnumerable<Transaction> transactions)
        => Calculate(account, transactions, through: null);

    /// <summary>Calculates an account balance using ledger entries dated on or before <paramref name="through"/>.</summary>
    public static Money Calculate(Account account, IEnumerable<Transaction> transactions, DateOnly through)
        => Calculate(account, transactions, (DateOnly?)through);

    private static Money Calculate(Account account, IEnumerable<Transaction> transactions, DateOnly? through)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(transactions);

        return new Money(account.OpeningBalance.Amount + transactions
            .Where(transaction => transaction.AccountId == account.Id && (through is null || transaction.Date <= through.Value))
            .Sum(transaction => transaction.Amount.Amount));
    }
}
