using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class MoneyTests
{
    [Fact]
    public void AdditionPreservesExactDecimalValue()
    {
        var total = new Money(0.10m) + new Money(0.20m);

        Assert.Equal(new Money(0.30m), total);
    }
}
