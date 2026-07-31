using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class RecurringTransactionDetectorTests
{
    [Fact]
    public void DetectsDailyPatternAndInfersNextDate()
    {
        var accountId = Guid.NewGuid();
        var entries = new[]
        {
            Entry(accountId, new DateOnly(2026, 7, 3), "Parking", -8m),
            Entry(accountId, new DateOnly(2026, 7, 4), "Parking", -8m),
            Entry(accountId, new DateOnly(2026, 7, 5), "Parking", -8m),
        };

        var suggestion = Assert.Single(RecurringTransactionDetector.Detect(entries));

        Assert.Equal(ScheduledTransactionRecurrence.Daily, suggestion.Recurrence);
        Assert.Equal(new DateOnly(2026, 7, 6), suggestion.NextOccurrenceDate);
    }

    [Fact]
    public void DetectsWeeklyPatternUsingNormalizedDescriptionAndInfersNextDate()
    {
        var accountId = Guid.NewGuid();
        var entries = new[]
        {
            Entry(accountId, new DateOnly(2026, 7, 3), "Corner-Mart", -42.10m),
            Entry(accountId, new DateOnly(2026, 7, 10), "corner mart", -42.10m),
            Entry(accountId, new DateOnly(2026, 7, 17), "CORNER MART!", -42.10m),
        };

        var suggestion = Assert.Single(RecurringTransactionDetector.Detect(entries));

        Assert.Equal(ScheduledTransactionRecurrence.Weekly, suggestion.Recurrence);
        Assert.Equal(new DateOnly(2026, 7, 24), suggestion.NextOccurrenceDate);
        Assert.Equal("CORNER MART", suggestion.NormalizedDescription);
        Assert.Equal(entries.Select(entry => entry.Id), suggestion.SourceTransactionIds);
    }

    [Fact]
    public void DetectsMonthlyPatternAcrossShortMonthAndInfersClippedNextDate()
    {
        var accountId = Guid.NewGuid();
        var entries = new[]
        {
            Entry(accountId, new DateOnly(2026, 1, 31), "Mortgage", -1200m),
            Entry(accountId, new DateOnly(2026, 2, 28), "Mortgage", -1200m),
            Entry(accountId, new DateOnly(2026, 3, 31), "Mortgage", -1200m),
        };

        var suggestion = Assert.Single(RecurringTransactionDetector.Detect(entries));

        Assert.Equal(ScheduledTransactionRecurrence.Monthly, suggestion.Recurrence);
        Assert.Equal(new DateOnly(2026, 4, 30), suggestion.NextOccurrenceDate);
    }

    [Fact]
    public void RequiresThreeExactMatchesAndKeepsAccountsAmountsAndAdjustmentsSeparate()
    {
        var accountId = Guid.NewGuid();
        var otherAccountId = Guid.NewGuid();
        var entries = new[]
        {
            Entry(accountId, new DateOnly(2026, 7, 1), "Rent", -1000m),
            Entry(accountId, new DateOnly(2026, 7, 8), "Rent", -999.99m),
            Entry(accountId, new DateOnly(2026, 7, 15), "Rent", -1000m),
            Entry(otherAccountId, new DateOnly(2026, 7, 8), "Rent", -1000m),
            Transaction.CreateBalanceAdjustment(Guid.NewGuid(), accountId, new DateOnly(2026, 7, 22), new Money(100m), "reconcile", DateTimeOffset.UtcNow),
        };

        Assert.Empty(RecurringTransactionDetector.Detect(entries));
    }

    [Fact]
    public void SeparatesDistinctRunsInsteadOfBridgingAnIrregularDate()
    {
        var accountId = Guid.NewGuid();
        var entries = new[]
        {
            Entry(accountId, new DateOnly(2026, 7, 1), "Gym", -30m),
            Entry(accountId, new DateOnly(2026, 7, 8), "Gym", -30m),
            Entry(accountId, new DateOnly(2026, 7, 15), "Gym", -30m),
            Entry(accountId, new DateOnly(2026, 7, 31), "Gym", -30m),
            Entry(accountId, new DateOnly(2026, 8, 7), "Gym", -30m),
            Entry(accountId, new DateOnly(2026, 8, 14), "Gym", -30m),
        };

        var suggestions = RecurringTransactionDetector.Detect(entries);

        Assert.Equal(2, suggestions.Count);
        Assert.All(suggestions, suggestion => Assert.Equal(ScheduledTransactionRecurrence.Weekly, suggestion.Recurrence));
        Assert.Equal(new[] { new DateOnly(2026, 7, 22), new DateOnly(2026, 8, 21) }, suggestions.Select(suggestion => suggestion.NextOccurrenceDate));
    }

    private static Transaction Entry(Guid accountId, DateOnly date, string description, decimal amount) =>
        new(Guid.NewGuid(), accountId, date, description, new Money(amount), null, null, DateTimeOffset.UtcNow);
}
