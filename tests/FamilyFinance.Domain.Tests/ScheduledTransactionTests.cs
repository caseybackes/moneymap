using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class ScheduledTransactionTests
{
    [Fact]
    public void MonthlySchedule_ClipsAnchorDayToEndOfShortMonth()
    {
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 1, 31), null,
            "Mortgage", new Money(-1000m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        Assert.Equal(
            new[] { new DateOnly(2026, 1, 31), new DateOnly(2026, 2, 28), new DateOnly(2026, 3, 31) },
            schedule.GetOccurrenceDates(new DateOnly(2026, 1, 1), new DateOnly(2026, 3, 31)));
    }

    [Fact]
    public void ScheduledTransaction_HonorsEndDate()
    {
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 3),
            "Daily transfer", new Money(-10m), null, null, ScheduledTransactionRecurrence.Daily, DateTimeOffset.UtcNow);

        Assert.Equal(
            new[] { new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 2), new DateOnly(2026, 8, 3) },
            schedule.GetOccurrenceDates(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 31)));
    }
}
