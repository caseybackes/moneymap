namespace FamilyFinance.Domain;

public readonly record struct Money(decimal Amount)
{
    /// <summary>
    /// Ledger convention: positive values are money received (income) and negative values are money spent.
    /// </summary>
    public static Money Zero => new(0m);

    public static Money operator +(Money left, Money right) => new(left.Amount + right.Amount);

    public static Money operator -(Money left, Money right) => new(left.Amount - right.Amount);
}
