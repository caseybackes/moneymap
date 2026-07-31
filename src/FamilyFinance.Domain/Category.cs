namespace FamilyFinance.Domain;

public sealed record Category
{
    public Category(Guid id, string name)
    {
        if (id == Guid.Empty)
        {
            throw new ArgumentException("A category requires an identifier.", nameof(id));
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            throw new ArgumentException("A category requires a name.", nameof(name));
        }

        Id = id;
        Name = name.Trim();
    }

    public Guid Id { get; }
    public string Name { get; }
}
