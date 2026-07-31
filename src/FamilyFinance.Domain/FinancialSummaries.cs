namespace FamilyFinance.Domain;

public sealed record PeriodSummary(Money TotalBalance, Money Income, Money Spending);

public sealed record CalendarDaySummary(DateOnly Date, Money Income, Money Spending);

public static class FinancialSummaries
{
    public static PeriodSummary ForPeriod(IEnumerable<Account> accounts, IEnumerable<Transaction> transactions, int year, int month)
    {
        ArgumentNullException.ThrowIfNull(accounts);
        ArgumentNullException.ThrowIfNull(transactions);

        var transactionList = transactions.ToList();
        var totalBalance = accounts.Sum(account => AccountBalanceCalculator.Calculate(account, transactionList).Amount);
        var periodTransactions = transactionList.Where(transaction => transaction.Date.Year == year && transaction.Date.Month == month);
        var income = periodTransactions.Where(transaction => transaction.Amount.Amount > 0m).Sum(transaction => transaction.Amount.Amount);
        var spending = -periodTransactions.Where(transaction => transaction.Amount.Amount < 0m).Sum(transaction => transaction.Amount.Amount);

        return new PeriodSummary(new Money(totalBalance), new Money(income), new Money(spending));
    }

    public static IReadOnlyList<CalendarDaySummary> ForMonth(IEnumerable<Transaction> transactions, int year, int month)
    {
        ArgumentNullException.ThrowIfNull(transactions);

        return transactions
            .Where(transaction => transaction.Date.Year == year && transaction.Date.Month == month)
            .GroupBy(transaction => transaction.Date)
            .OrderBy(group => group.Key)
            .Select(group => new CalendarDaySummary(
                group.Key,
                new Money(group.Where(transaction => transaction.Amount.Amount > 0m).Sum(transaction => transaction.Amount.Amount)),
                new Money(-group.Where(transaction => transaction.Amount.Amount < 0m).Sum(transaction => transaction.Amount.Amount))))
            .ToList();
    }
}
