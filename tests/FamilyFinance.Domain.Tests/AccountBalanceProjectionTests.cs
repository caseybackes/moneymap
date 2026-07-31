using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class AccountBalanceProjectionTests
{
    [Fact]
    public void CalculatesOneAccountThroughTheRequestedDateFromLedgerAndSchedule()
    {
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, new Money(100m));
        var otherAccount = Guid.NewGuid();
        var schedule = new ScheduledTransaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 5), null,
            "Rent", new Money(-40m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        var otherSchedule = new ScheduledTransaction(Guid.NewGuid(), otherAccount, new DateOnly(2026, 8, 5), null,
            "Other", new Money(900m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        var result = AccountBalanceProjector.Calculate(
            account,
            new[]
            {
                new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Income", new Money(20m), null, null, DateTimeOffset.UtcNow),
                new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 9, 1), "Future", new Money(500m), null, null, DateTimeOffset.UtcNow),
                new Transaction(Guid.NewGuid(), otherAccount, new DateOnly(2026, 8, 1), "Other", new Money(500m), null, null, DateTimeOffset.UtcNow),
            },
            new[]
            {
                new ScheduledTransactionOccurrence(schedule, new DateOnly(2026, 8, 5)),
                new ScheduledTransactionOccurrence(schedule, new DateOnly(2026, 9, 5)),
                new ScheduledTransactionOccurrence(otherSchedule, new DateOnly(2026, 8, 5)),
            },
            new DateOnly(2026, 8, 31));

        Assert.Equal(new Money(120m), result.LedgerBalance);
        Assert.Equal(new Money(-40m), result.ScheduledChange);
        Assert.Equal(new Money(80m), result.ProjectedBalance);
    }
}
