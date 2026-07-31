using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class FinancialSummariesTests
{
    [Fact]
    public void ProducesBalancesAndIncomeSpendingSeparately()
    {
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, new Money(100m));
        var transactions = new[]
        {
            Entry(account.Id, new DateOnly(2026, 7, 1), 50m),
            Entry(account.Id, new DateOnly(2026, 7, 2), -25m),
            Entry(account.Id, new DateOnly(2026, 8, 1), -10m)
        };

        var summary = FinancialSummaries.ForPeriod(new[] { account }, transactions, 2026, 7);

        Assert.Equal(new Money(115m), summary.TotalBalance);
        Assert.Equal(new Money(50m), summary.Income);
        Assert.Equal(new Money(25m), summary.Spending);
    }

    [Fact]
    public void GroupsCalendarTotalsByDate()
    {
        var accountId = Guid.NewGuid();
        var totals = FinancialSummaries.ForMonth(new[]
        {
            Entry(accountId, new DateOnly(2026, 7, 1), 20m),
            Entry(accountId, new DateOnly(2026, 7, 1), -3m),
            Entry(accountId, new DateOnly(2026, 7, 2), -7m)
        }, 2026, 7);

        Assert.Collection(totals,
            day => Assert.Equal((new DateOnly(2026, 7, 1), new Money(20m), new Money(3m)), (day.Date, day.Income, day.Spending)),
            day => Assert.Equal((new DateOnly(2026, 7, 2), Money.Zero, new Money(7m)), (day.Date, day.Income, day.Spending)));
    }

    private static Transaction Entry(Guid accountId, DateOnly date, decimal amount) =>
        new(Guid.NewGuid(), accountId, date, "Entry", new Money(amount), null, null, DateTimeOffset.UtcNow);
}
