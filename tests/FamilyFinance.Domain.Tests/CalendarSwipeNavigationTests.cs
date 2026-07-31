using FamilyFinance.App;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class CalendarSwipeNavigationTests
{
    [Theory]
    [InlineData(-501d, 1000d, 1)]
    [InlineData(501d, 1000d, -1)]
    [InlineData(-500d, 1000d, 0)]
    [InlineData(500d, 1000d, 0)]
    [InlineData(0d, 1000d, 0)]
    public void ChangesMonthOnlyWhenDragExceedsHalfTheViewport(double displacement, double width, int expectedOffset)
    {
        Assert.Equal(expectedOffset, CalendarSwipeNavigation.ResolveMonthOffset(displacement, width));
    }
}
