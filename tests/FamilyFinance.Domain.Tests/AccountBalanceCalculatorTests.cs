using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class AccountBalanceCalculatorTests
{
    [Fact]
    public void CalculatesBalanceFromOpeningBalanceAndOnlyMatchingTransactions()
    {
        var checking = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, new Money(1000.25m));
        var otherAccount = Guid.NewGuid();
        var transactions = new[]
        {
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 1), "Paycheck", new Money(2500.10m), null, null, DateTimeOffset.UtcNow),
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 2), "Groceries", new Money(-123.45m), null, null, DateTimeOffset.UtcNow),
            new Transaction(Guid.NewGuid(), otherAccount, new DateOnly(2026, 7, 2), "Elsewhere", new Money(900m), null, null, DateTimeOffset.UtcNow)
        };

        var balance = AccountBalanceCalculator.Calculate(checking, transactions);

        Assert.Equal(new Money(3376.90m), balance);
    }

    [Fact]
    public void AppliesSignedLedgerConventionForIncomeAndSpending()
    {
        var checking = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        var transactions = new[]
        {
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 1), "Income", new Money(100m), null, null, DateTimeOffset.UtcNow),
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 1), "Spending", new Money(-35m), null, null, DateTimeOffset.UtcNow)
        };

        Assert.Equal(new Money(65m), AccountBalanceCalculator.Calculate(checking, transactions));
    }

    [Fact]
    public void CalculatesBalanceAsOfTheRequestedLedgerDate()
    {
        var checking = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, new Money(100m));
        var transactions = new[]
        {
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 1), "Income", new Money(50m), null, null, DateTimeOffset.UtcNow),
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 2), "Spending", new Money(-20m), null, null, DateTimeOffset.UtcNow),
            new Transaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 7, 3), "Future income", new Money(1000m), null, null, DateTimeOffset.UtcNow),
        };

        Assert.Equal(new Money(130m), AccountBalanceCalculator.Calculate(checking, transactions, new DateOnly(2026, 7, 2)));
    }
}
