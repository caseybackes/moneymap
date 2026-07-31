namespace FamilyFinance.Domain;

/// <summary>
/// An immutable ledger entry. Amounts use the ledger convention: positive is income and negative is spending.
/// </summary>
public sealed record Transaction
{
    public Transaction(
        Guid id,
        Guid accountId,
        DateOnly date,
        string description,
        Money amount,
        Guid? categoryId,
        string? notes,
        DateTimeOffset createdAt,
        TransactionKind kind = TransactionKind.Regular,
        Money? balanceBeforeAdjustment = null,
        Money? targetBalance = null)
    {
        if (id == Guid.Empty)
        {
            throw new ArgumentException("A transaction requires an identifier.", nameof(id));
        }

        if (accountId == Guid.Empty)
        {
            throw new ArgumentException("A transaction requires an account.", nameof(accountId));
        }

        if (date == default)
        {
            throw new ArgumentException("A transaction requires a date.", nameof(date));
        }

        if (string.IsNullOrWhiteSpace(description))
        {
            throw new ArgumentException("A transaction requires a description.", nameof(description));
        }

        if (amount.Amount == 0m)
        {
            throw new ArgumentException("A transaction amount cannot be zero.", nameof(amount));
        }

        if (!Enum.IsDefined(kind))
        {
            throw new ArgumentOutOfRangeException(nameof(kind));
        }

        if (kind == TransactionKind.BalanceAdjustment && string.IsNullOrWhiteSpace(notes))
        {
            throw new ArgumentException("A balance adjustment requires a reason in its notes.", nameof(notes));
        }

        if (kind != TransactionKind.BalanceAdjustment && (balanceBeforeAdjustment is not null || targetBalance is not null))
        {
            throw new ArgumentException("Only a balance adjustment may record reconciliation balances.");
        }

        if ((balanceBeforeAdjustment is null) != (targetBalance is null))
        {
            throw new ArgumentException("A balance adjustment must record both its pre-adjustment and target balances.");
        }

        if (balanceBeforeAdjustment is not null && targetBalance is not null && amount != targetBalance.Value - balanceBeforeAdjustment.Value)
        {
            throw new ArgumentException("A balance adjustment amount must equal target balance minus pre-adjustment balance.", nameof(amount));
        }

        Id = id;
        AccountId = accountId;
        Date = date;
        Description = description.Trim();
        Amount = amount;
        CategoryId = categoryId;
        Notes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim();
        CreatedAt = createdAt;
        Kind = kind;
        BalanceBeforeAdjustment = balanceBeforeAdjustment;
        TargetBalance = targetBalance;
    }

    public Guid Id { get; }
    public Guid AccountId { get; }
    public DateOnly Date { get; }
    public string Description { get; }
    public Money Amount { get; }
    public Guid? CategoryId { get; }
    public string? Notes { get; }
    public DateTimeOffset CreatedAt { get; }
    public TransactionKind Kind { get; }
    /// <summary>The ledger balance used when an adjustment was created, if it was recorded.</summary>
    public Money? BalanceBeforeAdjustment { get; }
    /// <summary>The user-entered actual balance that the adjustment was intended to reach, if it was recorded.</summary>
    public Money? TargetBalance { get; }

    /// <summary>
    /// Creates an auditable ledger adjustment. The amount is the difference required to reach a user-entered balance.
    /// </summary>
    public static Transaction CreateBalanceAdjustment(
        Guid id,
        Guid accountId,
        DateOnly date,
        Money amount,
        string reason,
        DateTimeOffset createdAt) =>
        new(id, accountId, date, "Balance adjustment", amount, null, reason, createdAt, TransactionKind.BalanceAdjustment);

    /// <summary>
    /// Creates an auditable adjustment from the calculated ledger balance to the user-entered target balance.
    /// The stored amount is derived here so callers cannot accidentally record an inconsistent reconciliation.
    /// </summary>
    public static Transaction CreateBalanceAdjustment(
        Guid id,
        Guid accountId,
        DateOnly date,
        Money balanceBeforeAdjustment,
        Money targetBalance,
        string reason,
        DateTimeOffset createdAt) =>
        new(id, accountId, date, "Balance adjustment", targetBalance - balanceBeforeAdjustment, null, reason, createdAt,
            TransactionKind.BalanceAdjustment, balanceBeforeAdjustment, targetBalance);

    public Transaction Edit(
        Guid accountId,
        DateOnly date,
        string description,
        Money amount,
        Guid? categoryId,
        string? notes) =>
        new(Id, accountId, date, description, amount, categoryId, notes, CreatedAt, Kind, BalanceBeforeAdjustment, TargetBalance);
}

public enum TransactionKind
{
    Regular,
    BalanceAdjustment,
}
