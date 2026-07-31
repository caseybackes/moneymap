using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class ValidationTests
{
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void AccountRequiresName(string name) =>
        Assert.Throws<ArgumentException>(() => new Account(Guid.NewGuid(), name, AccountType.Checking, Money.Zero));

    [Fact]
    public void AccountRequiresIdentifier() =>
        Assert.Throws<ArgumentException>(() => new Account(Guid.Empty, "Checking", AccountType.Checking, Money.Zero));

    [Fact]
    public void AccountRejectsUnsupportedType() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new Account(Guid.NewGuid(), "Checking", (AccountType)999, Money.Zero));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void CategoryRequiresName(string name) =>
        Assert.Throws<ArgumentException>(() => new Category(Guid.NewGuid(), name));

    [Fact]
    public void TransactionRequiresItsCoreFields()
    {
        var id = Guid.NewGuid();
        var accountId = Guid.NewGuid();

        Assert.Throws<ArgumentException>(() => new Transaction(Guid.Empty, accountId, new DateOnly(2026, 7, 1), "Pay", new Money(1m), null, null, DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentException>(() => new Transaction(id, Guid.Empty, new DateOnly(2026, 7, 1), "Pay", new Money(1m), null, null, DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentException>(() => new Transaction(id, accountId, default, "Pay", new Money(1m), null, null, DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentException>(() => new Transaction(id, accountId, new DateOnly(2026, 7, 1), " ", new Money(1m), null, null, DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentException>(() => new Transaction(id, accountId, new DateOnly(2026, 7, 1), "Pay", Money.Zero, null, null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void TransactionEditPreservesIdentityAndCreationTime()
    {
        var original = new Transaction(Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 7, 1), "Original", new Money(-1m), null, null, DateTimeOffset.UtcNow);

        var edited = original.Edit(original.AccountId, new DateOnly(2026, 7, 2), "Updated", new Money(2m), Guid.NewGuid(), "note");

        Assert.Equal(original.Id, edited.Id);
        Assert.Equal(original.CreatedAt, edited.CreatedAt);
        Assert.Equal(new Money(2m), edited.Amount);
    }
}
