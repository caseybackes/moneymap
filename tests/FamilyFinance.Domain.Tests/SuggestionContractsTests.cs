using FamilyFinance.AI;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class SuggestionContractsTests
{
    [Fact]
    public void CategoryRequest_CopiesAvailableCategoriesForReviewOnlyInput()
    {
        var categoryId = Guid.NewGuid();
        var candidates = new List<CategoryCandidate> { new(categoryId, "Groceries") };
        var request = new CategoryRecommendationRequest(Context(), "Market purchase", candidates);
        candidates.Clear();

        Assert.Single(request.AvailableCategories);
        Assert.Equal(categoryId, request.AvailableCategories[0].CategoryId);
    }

    [Theory]
    [InlineData(-0.01)]
    [InlineData(1.01)]
    public void Confidence_RejectsValuesOutsideZeroToOne(decimal value)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new SuggestionConfidence(value));
    }

    [Fact]
    public void Recommendation_ResultRetainsRequestContextAndProvenance()
    {
        var context = Context();
        var provenance = new SuggestionProvenance("local-test", DateTimeOffset.UtcNow, "test-model");
        var result = new CategoryRecommendationResult(
            context,
            [new CategoryRecommendation(Guid.NewGuid(), new SuggestionConfidence(0.8m), provenance)]);

        var recommendation = Assert.Single(result.Recommendations);
        Assert.Same(context, result.Context);
        Assert.Same(provenance, recommendation.Provenance);
    }

    [Fact]
    public void Review_CapturesAnExplicitRejectionWithoutChangingTheProposal()
    {
        var requestId = Guid.NewGuid();
        var reviewedAt = DateTimeOffset.UtcNow;
        var review = new SuggestionReview(
            Guid.NewGuid(),
            requestId,
            SuggestionReviewDisposition.Rejected,
            reviewedAt,
            "This merchant is a business expense.");

        Assert.Equal(requestId, review.RequestId);
        Assert.Equal(SuggestionReviewDisposition.Rejected, review.Disposition);
        Assert.Equal(reviewedAt, review.ReviewedAt);
        Assert.Equal("This merchant is a business expense.", review.UserReason);
    }

    [Fact]
    public void Review_RequiresTimestampOnceUserMakesADecision()
    {
        Assert.Throws<ArgumentException>(() => new SuggestionReview(
            Guid.NewGuid(),
            Guid.NewGuid(),
            SuggestionReviewDisposition.Accepted));
    }

    private static SuggestionRequestContext Context() => new(Guid.NewGuid(), Guid.NewGuid());
}
