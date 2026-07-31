namespace FamilyFinance.Domain;

public enum AccountType
{
    Checking,
    Savings,
    CreditCard,
    Retirement,
    Investment,
    Tax,
    Cash,
    Other
}

public sealed record Account
{
    public Account(Guid id, string name, AccountType type, Money openingBalance)
    {
        if (id == Guid.Empty)
        {
            throw new ArgumentException("An account requires an identifier.", nameof(id));
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            throw new ArgumentException("An account requires a name.", nameof(name));
        }

        if (!Enum.IsDefined(type))
        {
            throw new ArgumentOutOfRangeException(nameof(type), type, "An account requires a supported account type.");
        }

        Id = id;
        Name = name.Trim();
        Type = type;
        OpeningBalance = openingBalance;
    }

    public Guid Id { get; }
    public string Name { get; }
    public AccountType Type { get; }
    public Money OpeningBalance { get; }
}
