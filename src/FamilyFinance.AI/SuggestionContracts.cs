using System.Collections.Immutable;

namespace FamilyFinance.AI;

/// <summary>
/// A provider-neutral boundary for producing reviewable suggestions from transaction text.
/// Implementations must not persist, edit, or otherwise mutate ledger data.
/// </summary>
public interface ITransactionSuggestionService
{
    Task<MerchantNormalizationResult> NormalizeMerchantAsync(
        MerchantNormalizationRequest request,
        CancellationToken cancellationToken = default);

    Task<CategoryRecommendationResult> RecommendCategoriesAsync(
        CategoryRecommendationRequest request,
        CancellationToken cancellationToken = default);
}

/// <summary>Identifies a request so its resulting proposals can be associated with a UI review operation.</summary>
public sealed record SuggestionRequestContext
{
    public SuggestionRequestContext(Guid requestId, Guid transactionId)
    {
        if (requestId == Guid.Empty)
        {
            throw new ArgumentException("A suggestion request requires an identifier.", nameof(requestId));
        }

        if (transactionId == Guid.Empty)
        {
            throw new ArgumentException("A suggestion request requires a transaction identifier.", nameof(transactionId));
        }

        RequestId = requestId;
        TransactionId = transactionId;
    }

    public Guid RequestId { get; }
    public Guid TransactionId { get; }
}

/// <summary>Input used to propose a canonical merchant name from a transaction description.</summary>
public sealed record MerchantNormalizationRequest
{
    public MerchantNormalizationRequest(SuggestionRequestContext context, string rawDescription)
    {
        Context = context ?? throw new ArgumentNullException(nameof(context));
        RawDescription = ContractText.Require(rawDescription, nameof(rawDescription));
    }

    public SuggestionRequestContext Context { get; }
    public string RawDescription { get; }
}

/// <summary>Input used to rank the user's own category choices for a transaction.</summary>
public sealed record CategoryRecommendationRequest
{
    public CategoryRecommendationRequest(
        SuggestionRequestContext context,
        string description,
        IEnumerable<CategoryCandidate> availableCategories)
    {
        Context = context ?? throw new ArgumentNullException(nameof(context));
        Description = ContractText.Require(description, nameof(description));
        AvailableCategories = availableCategories?.ToImmutableArray()
            ?? throw new ArgumentNullException(nameof(availableCategories));

        if (AvailableCategories.IsDefaultOrEmpty)
        {
            throw new ArgumentException("At least one available category is required.", nameof(availableCategories));
        }
    }

    public SuggestionRequestContext Context { get; }
    public string Description { get; }
    public ImmutableArray<CategoryCandidate> AvailableCategories { get; }
}

/// <summary>A category that the user has made available for a recommendation.</summary>
public sealed record CategoryCandidate
{
    public CategoryCandidate(Guid categoryId, string name)
    {
        if (categoryId == Guid.Empty)
        {
            throw new ArgumentException("A category candidate requires an identifier.", nameof(categoryId));
        }

        CategoryId = categoryId;
        Name = ContractText.Require(name, nameof(name));
    }

    public Guid CategoryId { get; }
    public string Name { get; }
}

/// <summary>Identifies how a proposal was produced without binding the application to a provider.</summary>
public sealed record SuggestionProvenance
{
    public SuggestionProvenance(string source, DateTimeOffset generatedAt, string? model = null)
    {
        Source = ContractText.Require(source, nameof(source));
        GeneratedAt = generatedAt;
        Model = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
    }

    public string Source { get; }
    public DateTimeOffset GeneratedAt { get; }
    public string? Model { get; }
}

/// <summary>A bounded confidence score for a proposal.</summary>
public readonly record struct SuggestionConfidence
{
    public SuggestionConfidence(decimal value)
    {
        if (value is < 0m or > 1m)
        {
            throw new ArgumentOutOfRangeException(nameof(value), "Confidence must be between 0 and 1.");
        }

        Value = value;
    }

    public decimal Value { get; }
}

/// <summary>The explicit user-review state of a proposal. Review state never applies a proposal to the ledger.</summary>
public enum SuggestionReviewDisposition
{
    Pending,
    Accepted,
    Rejected,
}

/// <summary>
/// A standalone record of a user decision about proposals returned for one request.
/// This contract is not a command and does not persist or mutate any ledger data.
/// </summary>
public sealed record SuggestionReview
{
    public SuggestionReview(
        Guid reviewId,
        Guid requestId,
        SuggestionReviewDisposition disposition,
        DateTimeOffset? reviewedAt = null,
        string? userReason = null)
    {
        if (reviewId == Guid.Empty)
        {
            throw new ArgumentException("A suggestion review requires an identifier.", nameof(reviewId));
        }

        if (requestId == Guid.Empty)
        {
            throw new ArgumentException("A suggestion review requires a request identifier.", nameof(requestId));
        }

        if (!Enum.IsDefined(disposition))
        {
            throw new ArgumentOutOfRangeException(nameof(disposition));
        }

        if (disposition == SuggestionReviewDisposition.Pending && reviewedAt is not null)
        {
            throw new ArgumentException("A pending review cannot have a review timestamp.", nameof(reviewedAt));
        }

        if (disposition == SuggestionReviewDisposition.Pending && !string.IsNullOrWhiteSpace(userReason))
        {
            throw new ArgumentException("A pending review cannot have a user reason.", nameof(userReason));
        }

        if ((disposition is SuggestionReviewDisposition.Accepted or SuggestionReviewDisposition.Rejected) && reviewedAt is null)
        {
            throw new ArgumentException("An accepted or rejected review requires a timestamp.", nameof(reviewedAt));
        }

        ReviewId = reviewId;
        RequestId = requestId;
        Disposition = disposition;
        ReviewedAt = reviewedAt;
        UserReason = string.IsNullOrWhiteSpace(userReason) ? null : userReason.Trim();
    }

    public Guid ReviewId { get; }
    public Guid RequestId { get; }
    public SuggestionReviewDisposition Disposition { get; }
    public DateTimeOffset? ReviewedAt { get; }
    public string? UserReason { get; }
}

/// <summary>A proposed canonical merchant name. It is never a ledger update.</summary>
public sealed record MerchantNormalizationSuggestion(
    string MerchantName,
    SuggestionConfidence Confidence,
    SuggestionProvenance Provenance)
{
    public string MerchantName { get; } = ContractText.Require(MerchantName, nameof(MerchantName));
    public SuggestionProvenance Provenance { get; } = Provenance ?? throw new ArgumentNullException(nameof(Provenance));
}

/// <summary>A response containing a merchant proposal for explicit user review.</summary>
public sealed record MerchantNormalizationResult(
    SuggestionRequestContext Context,
    MerchantNormalizationSuggestion Suggestion)
{
    public SuggestionRequestContext Context { get; } = Context ?? throw new ArgumentNullException(nameof(Context));
    public MerchantNormalizationSuggestion Suggestion { get; } = Suggestion ?? throw new ArgumentNullException(nameof(Suggestion));
}

/// <summary>A proposed existing category. The proposal cannot create or change categories.</summary>
public sealed record CategoryRecommendation(
    Guid CategoryId,
    SuggestionConfidence Confidence,
    SuggestionProvenance Provenance)
{
    public Guid CategoryId { get; } = CategoryId == Guid.Empty
        ? throw new ArgumentException("A category recommendation requires an identifier.", nameof(CategoryId))
        : CategoryId;

    public SuggestionProvenance Provenance { get; } = Provenance ?? throw new ArgumentNullException(nameof(Provenance));
}

/// <summary>A ranked, review-only set of category proposals.</summary>
public sealed record CategoryRecommendationResult
{
    public CategoryRecommendationResult(
        SuggestionRequestContext context,
        IEnumerable<CategoryRecommendation> recommendations)
    {
        Context = context ?? throw new ArgumentNullException(nameof(context));
        Recommendations = recommendations?.ToImmutableArray()
            ?? throw new ArgumentNullException(nameof(recommendations));
    }

    public SuggestionRequestContext Context { get; }
    public ImmutableArray<CategoryRecommendation> Recommendations { get; }
}

internal static class ContractText
{
    public static string Require(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("A value is required.", parameterName);
        }

        return value.Trim();
    }
}
