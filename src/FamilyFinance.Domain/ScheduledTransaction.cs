namespace FamilyFinance.Domain;

public enum ScheduledTransactionRecurrence
{
    Daily,
    Weekly,
    Monthly,
}

/// <summary>A future ledger plan. It is distinct from, and never automatically written to, the ledger.</summary>
public sealed record ScheduledTransaction
{
    public ScheduledTransaction(
        Guid id,
        Guid accountId,
        DateOnly startDate,
        DateOnly? endDate,
        string description,
        Money amount,
        Guid? categoryId,
        string? notes,
        ScheduledTransactionRecurrence recurrence,
        DateTimeOffset createdAt)
    {
        if (id == Guid.Empty)
        {
            throw new ArgumentException("A scheduled transaction requires an identifier.", nameof(id));
        }

        if (accountId == Guid.Empty)
        {
            throw new ArgumentException("A scheduled transaction requires an account.", nameof(accountId));
        }

        if (startDate == default)
        {
            throw new ArgumentException("A scheduled transaction requires a start date.", nameof(startDate));
        }

        if (endDate is not null && endDate < startDate)
        {
            throw new ArgumentException("An end date cannot precede the start date.", nameof(endDate));
        }

        if (string.IsNullOrWhiteSpace(description))
        {
            throw new ArgumentException("A scheduled transaction requires a description.", nameof(description));
        }

        if (amount.Amount == 0m)
        {
            throw new ArgumentException("A scheduled transaction amount cannot be zero.", nameof(amount));
        }

        if (!Enum.IsDefined(recurrence))
        {
            throw new ArgumentOutOfRangeException(nameof(recurrence));
        }

        Id = id;
        AccountId = accountId;
        StartDate = startDate;
        EndDate = endDate;
        Description = description.Trim();
        Amount = amount;
        CategoryId = categoryId;
        Notes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim();
        Recurrence = recurrence;
        CreatedAt = createdAt;
    }

    public Guid Id { get; }
    public Guid AccountId { get; }
    public DateOnly StartDate { get; }
    public DateOnly? EndDate { get; }
    public string Description { get; }
    public Money Amount { get; }
    public Guid? CategoryId { get; }
    public string? Notes { get; }
    public ScheduledTransactionRecurrence Recurrence { get; }
    public DateTimeOffset CreatedAt { get; }

    /// <summary>
    /// Returns a validated replacement for this plan while preserving its durable identity and creation time.
    /// Posted and skipped occurrences remain associated with this schedule's identifier.
    /// </summary>
    public ScheduledTransaction Edit(
        Guid accountId,
        DateOnly startDate,
        DateOnly? endDate,
        string description,
        Money amount,
        Guid? categoryId,
        string? notes,
        ScheduledTransactionRecurrence recurrence) =>
        new(Id, accountId, startDate, endDate, description, amount, categoryId, notes, recurrence, CreatedAt);

    /// <summary>Returns occurrences in an inclusive range, bounded by the schedule's start and optional end dates.</summary>
    public IEnumerable<DateOnly> GetOccurrenceDates(DateOnly from, DateOnly through)
    {
        if (from > through)
        {
            throw new ArgumentException("The range start cannot be after its end.", nameof(from));
        }

        for (var index = 0; ; index++)
        {
            var occurrence = GetOccurrenceDate(index);
            if (occurrence > through || (EndDate is not null && occurrence > EndDate.Value))
            {
                yield break;
            }

            if (occurrence >= from)
            {
                yield return occurrence;
            }
        }
    }

    private DateOnly GetOccurrenceDate(int index) => Recurrence switch
    {
        ScheduledTransactionRecurrence.Daily => StartDate.AddDays(index),
        ScheduledTransactionRecurrence.Weekly => StartDate.AddDays(7 * index),
        ScheduledTransactionRecurrence.Monthly => MonthlyOccurrence(index),
        _ => throw new InvalidOperationException("Unsupported recurrence."),
    };

    private DateOnly MonthlyOccurrence(int index)
    {
        var firstOfTargetMonth = new DateOnly(StartDate.Year, StartDate.Month, 1).AddMonths(index);
        return new DateOnly(
            firstOfTargetMonth.Year,
            firstOfTargetMonth.Month,
            Math.Min(StartDate.Day, DateTime.DaysInMonth(firstOfTargetMonth.Year, firstOfTargetMonth.Month)));
    }
}

/// <summary>An explicit decision to omit a single planned occurrence while preserving the schedule.</summary>
public sealed record ScheduledTransactionSkip
{
    public ScheduledTransactionSkip(Guid scheduledTransactionId, DateOnly occurrenceDate, DateTimeOffset skippedAt, string? reason)
    {
        if (scheduledTransactionId == Guid.Empty)
        {
            throw new ArgumentException("A skipped occurrence requires a schedule identifier.", nameof(scheduledTransactionId));
        }

        if (occurrenceDate == default)
        {
            throw new ArgumentException("A skipped occurrence requires a date.", nameof(occurrenceDate));
        }

        ScheduledTransactionId = scheduledTransactionId;
        OccurrenceDate = occurrenceDate;
        SkippedAt = skippedAt;
        Reason = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
    }

    public Guid ScheduledTransactionId { get; }
    public DateOnly OccurrenceDate { get; }
    public DateTimeOffset SkippedAt { get; }
    public string? Reason { get; }
}

/// <summary>A non-persisted future occurrence calculated from a schedule after skips are applied.</summary>
public sealed record ScheduledTransactionOccurrence(ScheduledTransaction Schedule, DateOnly Date);

/// <summary>
/// Immutable audit link proving that one planned occurrence became one authoritative ledger entry.
/// </summary>
public sealed record ScheduledTransactionPosting
{
    public ScheduledTransactionPosting(Guid scheduledTransactionId, DateOnly occurrenceDate, Guid transactionId, DateTimeOffset postedAt)
    {
        if (scheduledTransactionId == Guid.Empty) throw new ArgumentException("A posting requires a schedule identifier.", nameof(scheduledTransactionId));
        if (occurrenceDate == default) throw new ArgumentException("A posting requires an occurrence date.", nameof(occurrenceDate));
        if (transactionId == Guid.Empty) throw new ArgumentException("A posting requires a transaction identifier.", nameof(transactionId));

        ScheduledTransactionId = scheduledTransactionId;
        OccurrenceDate = occurrenceDate;
        TransactionId = transactionId;
        PostedAt = postedAt;
    }

    public Guid ScheduledTransactionId { get; }
    public DateOnly OccurrenceDate { get; }
    public Guid TransactionId { get; }
    public DateTimeOffset PostedAt { get; }
}
