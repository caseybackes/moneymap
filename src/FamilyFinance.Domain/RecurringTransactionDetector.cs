using System.Text;

namespace FamilyFinance.Domain;

/// <summary>
/// Deterministically finds repeated regular ledger entries that are suitable for a user-reviewed schedule suggestion.
/// It never creates a schedule or changes the ledger.
/// </summary>
public static class RecurringTransactionDetector
{
    private const int MinimumOccurrences = 3;

    public static IReadOnlyList<RecurringTransactionSuggestion> Detect(IEnumerable<Transaction> transactions)
    {
        ArgumentNullException.ThrowIfNull(transactions);

        var suggestions = new List<RecurringTransactionSuggestion>();
        var groups = transactions
            .Where(transaction => transaction.Kind == TransactionKind.Regular)
            .GroupBy(transaction => new PatternKey(
                transaction.AccountId,
                NormalizeDescription(transaction.Description),
                transaction.Amount))
            .OrderBy(group => group.Key.AccountId)
            .ThenBy(group => group.Key.NormalizedDescription, StringComparer.Ordinal)
            .ThenBy(group => group.Key.Amount.Amount);

        foreach (var group in groups)
        {
            var entries = group.OrderBy(transaction => transaction.Date)
                .ThenBy(transaction => transaction.CreatedAt)
                .ThenBy(transaction => transaction.Id)
                .ToArray();

            foreach (var recurrence in new[] { ScheduledTransactionRecurrence.Daily, ScheduledTransactionRecurrence.Weekly, ScheduledTransactionRecurrence.Monthly })
            {
                foreach (var run in FindRuns(entries, recurrence))
                {
                    suggestions.Add(new RecurringTransactionSuggestion(
                        group.Key.AccountId,
                        run[0].Description,
                        group.Key.NormalizedDescription,
                        group.Key.Amount,
                        recurrence,
                        NextOccurrenceDate(run, recurrence),
                        run.Select(transaction => transaction.Id).ToArray()));
                }
            }
        }

        return suggestions
            .OrderBy(suggestion => suggestion.AccountId)
            .ThenBy(suggestion => suggestion.NormalizedDescription, StringComparer.Ordinal)
            .ThenBy(suggestion => suggestion.Amount.Amount)
            .ThenBy(suggestion => suggestion.Recurrence)
            .ThenBy(suggestion => suggestion.NextOccurrenceDate)
            .ToArray();
    }

    /// <summary>Case, punctuation, and whitespace insensitive matching key for merchant descriptions.</summary>
    public static string NormalizeDescription(string description)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(description);

        var normalized = new StringBuilder(description.Length);
        var precedingWasSpace = false;
        foreach (var character in description.Trim())
        {
            if (char.IsLetterOrDigit(character))
            {
                normalized.Append(char.ToUpperInvariant(character));
                precedingWasSpace = false;
            }
            else if (!precedingWasSpace)
            {
                normalized.Append(' ');
                precedingWasSpace = true;
            }
        }

        return normalized.ToString().Trim();
    }

    private static IEnumerable<Transaction[]> FindRuns(Transaction[] entries, ScheduledTransactionRecurrence recurrence)
    {
        var runStart = 0;
        for (var index = 1; index <= entries.Length; index++)
        {
            var continuesRun = index < entries.Length && IsNextOccurrence(entries[runStart].Date, entries[index - 1].Date, entries[index].Date, recurrence, index - runStart);
            if (continuesRun)
            {
                continue;
            }

            if (index - runStart >= MinimumOccurrences)
            {
                yield return entries[runStart..index];
            }

            runStart = index;
        }
    }

    private static bool IsNextOccurrence(DateOnly start, DateOnly previous, DateOnly candidate, ScheduledTransactionRecurrence recurrence, int occurrenceIndex) => recurrence switch
    {
        ScheduledTransactionRecurrence.Daily => candidate == previous.AddDays(1),
        ScheduledTransactionRecurrence.Weekly => candidate == previous.AddDays(7),
        ScheduledTransactionRecurrence.Monthly => candidate == MonthlyOccurrence(start, occurrenceIndex),
        _ => throw new ArgumentOutOfRangeException(nameof(recurrence)),
    };

    private static DateOnly NextOccurrenceDate(Transaction[] run, ScheduledTransactionRecurrence recurrence) => recurrence switch
    {
        ScheduledTransactionRecurrence.Daily => run[^1].Date.AddDays(1),
        ScheduledTransactionRecurrence.Weekly => run[^1].Date.AddDays(7),
        ScheduledTransactionRecurrence.Monthly => MonthlyOccurrence(run[0].Date, run.Length),
        _ => throw new ArgumentOutOfRangeException(nameof(recurrence)),
    };

    private static DateOnly MonthlyOccurrence(DateOnly start, int monthsAfterStart)
    {
        var targetMonth = new DateOnly(start.Year, start.Month, 1).AddMonths(monthsAfterStart);
        return new DateOnly(targetMonth.Year, targetMonth.Month, Math.Min(start.Day, DateTime.DaysInMonth(targetMonth.Year, targetMonth.Month)));
    }

    private readonly record struct PatternKey(Guid AccountId, string NormalizedDescription, Money Amount);
}

/// <summary>A non-mutating schedule recommendation derived from an exact ledger pattern.</summary>
public sealed record RecurringTransactionSuggestion(
    Guid AccountId,
    string Description,
    string NormalizedDescription,
    Money Amount,
    ScheduledTransactionRecurrence Recurrence,
    DateOnly NextOccurrenceDate,
    IReadOnlyList<Guid> SourceTransactionIds);
