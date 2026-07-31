using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using FamilyFinance.App;
using FamilyFinance.Data;
using FamilyFinance.Domain;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class DesktopWorkflowTests : IDisposable
{
    private readonly string _databasePath = Path.Combine(Path.GetTempPath(), $"family-finance-ui-{Guid.NewGuid():N}.db");

    [Fact]
    public async Task EditedPersistedTransactionAppearsInLedgerAndCalendar()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();

            ClickNavigation(window, "Calendar");
            Dispatcher.UIThread.RunJobs();
            Click(window, "Add transaction");
            Dispatcher.UIThread.RunJobs();
            var dialog = window.OwnedWindows.Single();
            SetText(dialog, "Transaction description", "Market corrected");
            SetText(dialog, "Transaction amount", "-25.00");
            SetText(dialog, "Transaction notes", "Corrected amount");
            Click(dialog, "Save transaction");
            Dispatcher.UIThread.RunJobs();

            Assert.Contains("-$25.00", WindowText(window));

            ClickNavigation(window, "Ledger");
            Dispatcher.UIThread.RunJobs();
            Assert.Contains("Market corrected", WindowText(window));
            Assert.Contains("Corrected amount", WindowText(window));
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task CategoryCreatedInTheDesktopViewCanBeSelectedForATransaction()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        ledger.CreateAccount(new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Categories");
            Dispatcher.UIThread.RunJobs();
            Click(window, "Add category");
            Dispatcher.UIThread.RunJobs();
            var categoryDialog = window.OwnedWindows.Single();
            SetText(categoryDialog, "Category name", "Groceries");
            Click(categoryDialog, "Save category");
            Dispatcher.UIThread.RunJobs();
            Assert.Contains("Groceries", WindowText(window));

            Click(window, "Add transaction");
            Dispatcher.UIThread.RunJobs();
            var transactionDialog = window.OwnedWindows.Single();
            SetText(transactionDialog, "Transaction description", "Market");
            SetText(transactionDialog, "Transaction amount", "-12.50");
            var category = ledger.GetCategories().Single();
            var categoryPicker = transactionDialog.GetVisualDescendants().OfType<ComboBox>().Single(control => Avalonia.Automation.AutomationProperties.GetName(control) == "Transaction category");
            categoryPicker.SelectedItem = category;
            Click(transactionDialog, "Save transaction");
            Dispatcher.UIThread.RunJobs();

            Assert.Equal(category.Id, Assert.Single(ledger.GetTransactions()).CategoryId);
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task LedgerDeleteRequiresConfirmationAndAllowsLockedAdjustmentsToBeDeleted()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 30), "Market", new Money(-12.50m), null, null, DateTimeOffset.UtcNow));
        ledger.CreateTransaction(Transaction.CreateBalanceAdjustment(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 31), Money.Zero, new Money(100m), "Reconciled balance", DateTimeOffset.UtcNow));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Ledger");
            Dispatcher.UIThread.RunJobs();

            Click(window, "Delete Market");
            Dispatcher.UIThread.RunJobs();
            var confirmation = window.OwnedWindows.Single();
            Assert.Contains("cannot be undone", WindowText(confirmation));
            Click(confirmation, "Cancel delete transaction");
            Dispatcher.UIThread.RunJobs();
            Assert.Equal(2, ledger.GetTransactions().Count);

            Click(window, "Delete Market");
            Dispatcher.UIThread.RunJobs();
            confirmation = window.OwnedWindows.Single();
            Click(confirmation, "Confirm delete transaction");
            Dispatcher.UIThread.RunJobs();
            Assert.Equal(TransactionKind.BalanceAdjustment, Assert.Single(ledger.GetTransactions()).Kind);

            Click(window, "Delete Balance adjustment");
            Dispatcher.UIThread.RunJobs();
            confirmation = window.OwnedWindows.Single();
            Click(confirmation, "Confirm delete transaction");
            Dispatcher.UIThread.RunJobs();
            Assert.Empty(ledger.GetTransactions());
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task AccountBalanceAdjustmentCreatedInDesktopViewPersistsAuditValues()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        var adjustmentDate = new DateOnly(2026, 7, 15);

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Accounts");
            Dispatcher.UIThread.RunJobs();
            Click(window, "Adjust balance for Checking");
            Dispatcher.UIThread.RunJobs();

            var dialog = window.OwnedWindows.Single();
            SetText(dialog, "Actual account balance", "125.50");
            SetDate(dialog, "Adjustment date", adjustmentDate);
            SetText(dialog, "Adjustment reason", "Matched bank statement");
            Click(dialog, "Create balance adjustment");
            Dispatcher.UIThread.RunJobs();

            var stored = Assert.Single(ledger.GetTransactions());
            Assert.Equal(TransactionKind.BalanceAdjustment, stored.Kind);
            Assert.Equal("Balance adjustment", stored.Description);
            Assert.Equal(new Money(125.50m), stored.Amount);
            Assert.Equal(Money.Zero, stored.BalanceBeforeAdjustment);
            Assert.Equal(new Money(125.50m), stored.TargetBalance);
            Assert.Equal("Matched bank statement", stored.Notes);
            Assert.Equal(adjustmentDate, stored.Date);
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task BalanceAdjustmentUsesLedgerBalanceAsOfItsSelectedDate()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 10), "Earlier deposit", new Money(100m), null, null, DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 20), "Later deposit", new Money(200m), null, null, DateTimeOffset.UtcNow));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Accounts");
            Dispatcher.UIThread.RunJobs();
            Click(window, "Adjust balance for Checking");
            Dispatcher.UIThread.RunJobs();
            var dialog = window.OwnedWindows.Single();
            SetDate(dialog, "Adjustment date", new DateOnly(2026, 7, 15));
            SetText(dialog, "Actual account balance", "125.00");
            SetText(dialog, "Adjustment reason", "Statement matched");
            Click(dialog, "Create balance adjustment");
            Dispatcher.UIThread.RunJobs();

            var adjustment = ledger.GetTransactions().Single(transaction => transaction.Kind == TransactionKind.BalanceAdjustment);
            Assert.Equal(new Money(100m), adjustment.BalanceBeforeAdjustment);
            Assert.Equal(new Money(25m), adjustment.Amount);
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task BalanceAdjustmentIsLockedInLedgerInsteadOfOpeningTheGenericEditor()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        ledger.CreateTransaction(Transaction.CreateBalanceAdjustment(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 15), Money.Zero, new Money(25m), "Matched statement", DateTimeOffset.UtcNow));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Ledger");
            Dispatcher.UIThread.RunJobs();

            Assert.Contains("Balance adjustment - locked audit record", WindowText(window));
            Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(), button =>
                Avalonia.Automation.AutomationProperties.GetName(button) == "Edit Balance adjustment");
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task NewRecurringTransactionCreatesCurrentLedgerEntryAndFutureSchedule()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        ledger.CreateAccount(new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero));
        var transactionDate = new DateOnly(2026, 7, 15);

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            Click(window, "Add transaction");
            Dispatcher.UIThread.RunJobs();
            var dialog = window.OwnedWindows.Single();
            SetDate(dialog, "Transaction date", transactionDate);
            SetText(dialog, "Transaction description", "Rent");
            SetText(dialog, "Transaction amount", "-1000.00");
            SetChecked(dialog, "Repeat this transaction", true);
            var recurrence = dialog.GetVisualDescendants().OfType<ComboBox>().Single(control =>
                Avalonia.Automation.AutomationProperties.GetName(control) == "Transaction recurrence");
            recurrence.SelectedItem = ScheduledTransactionRecurrence.Monthly;
            Click(dialog, "Save transaction");
            Dispatcher.UIThread.RunJobs();

            var ledgerEntry = Assert.Single(ledger.GetTransactions());
            var schedule = Assert.Single(ledger.GetScheduledTransactions());
            Assert.Equal(transactionDate, ledgerEntry.Date);
            Assert.Equal(transactionDate.AddMonths(1), schedule.StartDate);
            Assert.Equal(ScheduledTransactionRecurrence.Monthly, schedule.Recurrence);
            Assert.Equal(ledgerEntry.Amount, schedule.Amount);
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task ScheduledTransactionCreatedInDesktopViewPersistsAndAppearsInCalendar()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        ledger.CreateAccount(new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero));
        var today = DateOnly.FromDateTime(DateTime.Today);

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Scheduled transactions");
            Dispatcher.UIThread.RunJobs();
            Click(window, "Add scheduled transaction");
            Dispatcher.UIThread.RunJobs();

            var dialog = window.OwnedWindows.Single();
            SetDate(dialog, "Scheduled transaction start date", today);
            SetText(dialog, "Scheduled transaction description", "Rent");
            SetText(dialog, "Scheduled transaction amount", "-75.00");
            SetText(dialog, "Scheduled transaction notes", "Lease payment");
            Click(dialog, "Save scheduled transaction");
            Dispatcher.UIThread.RunJobs();

            var schedule = Assert.Single(ledger.GetScheduledTransactions());
            Assert.Equal("Rent", schedule.Description);
            Assert.Equal(new Money(-75m), schedule.Amount);
            Assert.Equal(today, schedule.StartDate);
            Assert.Equal(ScheduledTransactionRecurrence.Monthly, schedule.Recurrence);
            Assert.Equal("Lease payment", schedule.Notes);

            ClickNavigation(window, "Calendar");
            Dispatcher.UIThread.RunJobs();
            Assert.Contains("-$75.00", WindowText(window));
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task ScheduledOccurrenceRecordedInDesktopViewBecomesOneLedgerEntryAndIsNoLongerUpcoming()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        var today = DateOnly.FromDateTime(DateTime.Today);
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, today, null, "Rent", new Money(-75m), null, "Lease payment",
            ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        ledger.CreateScheduledTransaction(schedule);

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Scheduled transactions");
            Dispatcher.UIThread.RunJobs();

            Click(window, $"Record Rent on {today:yyyy-MM-dd}");
            Dispatcher.UIThread.RunJobs();

            var entry = Assert.Single(ledger.GetTransactions());
            Assert.Equal(today, entry.Date);
            Assert.Equal(schedule.Description, entry.Description);
            Assert.Equal(schedule.Amount, entry.Amount);
            Assert.Equal(schedule.Notes, entry.Notes);
            Assert.Empty(ledger.GetScheduledOccurrences(today, today));
            Assert.Single(ledger.GetScheduledTransactionPostings(schedule.Id));
            Assert.Contains(today.ToString("ddd, MMM d, yyyy"), WindowText(window));
            Assert.Contains("Added", WindowText(window));

            ClickNavigation(window, "Ledger");
            Dispatcher.UIThread.RunJobs();
            Assert.Contains($"Posted from schedule · {today:MMM d, yyyy}", WindowText(window));
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task ScheduledTransactionCanBeEditedFromAnOccurrenceRow()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        var today = DateOnly.FromDateTime(DateTime.Today);
        var createdAt = DateTimeOffset.UtcNow.AddMinutes(-1);
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, today, null, "Rent", new Money(-75m), null, "Lease payment",
            ScheduledTransactionRecurrence.Monthly, createdAt);
        ledger.CreateScheduledTransaction(schedule);

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Scheduled transactions");
            Dispatcher.UIThread.RunJobs();

            Click(window, $"Edit Rent schedule on {today:yyyy-MM-dd}");
            Dispatcher.UIThread.RunJobs();
            var dialog = window.OwnedWindows.Single();
            Assert.Equal("Edit scheduled transaction", dialog.Title);
            Assert.Equal("Rent", dialog.GetVisualDescendants().OfType<TextBox>().Single(control =>
                Avalonia.Automation.AutomationProperties.GetName(control) == "Scheduled transaction description").Text);
            SetText(dialog, "Scheduled transaction description", "Updated rent");
            SetText(dialog, "Scheduled transaction amount", "-80.00");
            Click(dialog, "Save scheduled transaction");
            Dispatcher.UIThread.RunJobs();

            var stored = Assert.Single(ledger.GetScheduledTransactions());
            Assert.Equal(schedule.Id, stored.Id);
            Assert.Equal(createdAt, stored.CreatedAt);
            Assert.Equal("Updated rent", stored.Description);
            Assert.Equal(new Money(-80m), stored.Amount);
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task DashboardSuggestionCanBeExplicitlyAcceptedAsASchedule()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 5, 1), "Cloud Host", new Money(-20m), null, "Infrastructure", DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 6, 1), "cloud host", new Money(-20m), null, "Infrastructure", DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 1), "Cloud Host", new Money(-20m), null, "Infrastructure", DateTimeOffset.UtcNow));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            Dispatcher.UIThread.RunJobs();

            Assert.Contains("Recurring suggestions", WindowText(window));
            Assert.Contains("Evidence: May 1, Jun 1, Jul 1", WindowText(window));
            Click(window, "Add suggested schedule Cloud Host");
            Dispatcher.UIThread.RunJobs();
            var dialog = window.OwnedWindows.Single();
            SetChecked(dialog, "Set an end date", true);
            SetDate(dialog, "Scheduled transaction end date", new DateOnly(2026, 12, 1));
            Click(dialog, "Save scheduled transaction");
            Dispatcher.UIThread.RunJobs();

            var schedule = Assert.Single(ledger.GetScheduledTransactions());
            Assert.Equal(new DateOnly(2026, 8, 1), schedule.StartDate);
            Assert.Equal(new DateOnly(2026, 12, 1), schedule.EndDate);
            Assert.Equal(ScheduledTransactionRecurrence.Monthly, schedule.Recurrence);
            Assert.Equal("Infrastructure", schedule.Notes);
            Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(),
                control => Avalonia.Automation.AutomationProperties.GetName(control) == "Add suggested schedule Cloud Host");
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task DashboardSuggestionCanBeDismissedWithoutChangingLedgerOrSchedules()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        ledger.CreateAccount(account);
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 2), "Membership", new Money(-15m), null, null, DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 9), "Membership", new Money(-15m), null, null, DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 16), "Membership", new Money(-15m), null, null, DateTimeOffset.UtcNow));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            Dispatcher.UIThread.RunJobs();

            Click(window, "Dismiss suggested schedule Membership");
            Dispatcher.UIThread.RunJobs();

            Assert.DoesNotContain("Membership", WindowText(window));
            Assert.Equal(3, ledger.GetTransactions().Count);
            Assert.Empty(ledger.GetScheduledTransactions());
            window.Close();
        }, CancellationToken.None);
    }

    [Fact]
    public async Task LedgerFiltersApplyNameCategorySignedAmountAndInclusiveDatesTogetherAndCanReset()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var ledger = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        var groceries = new Category(Guid.NewGuid(), "Groceries");
        ledger.CreateAccount(account);
        ledger.CreateCategory(groceries);
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 1, 5), "Alpha Market", new Money(-20m), groceries.Id, null, DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 2, 15), "Alpha Subscription", new Money(-15m), null, null, DateTimeOffset.UtcNow));
        ledger.CreateTransaction(new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 3, 25), "Salary", new Money(100m), null, null, DateTimeOffset.UtcNow));

        using var session = HeadlessUnitTestSession.StartNew(typeof(FamilyFinance.App.App));
        await session.Dispatch(() =>
        {
            var window = new MainWindow(ledger);
            window.Show();
            ClickNavigation(window, "Ledger");
            Dispatcher.UIThread.RunJobs();

            SetText(window, "Ledger name filter", "subscription");
            var category = window.GetVisualDescendants().OfType<ComboBox>().Single(control => Avalonia.Automation.AutomationProperties.GetName(control) == "Ledger category filter");
            category.SelectedItem = "Uncategorized";
            SetText(window, "Ledger minimum amount filter", "-20");
            SetText(window, "Ledger maximum amount filter", "-10");
            SetDate(window, "Ledger from date filter", new DateOnly(2026, 2, 15));
            SetDate(window, "Ledger to date filter", new DateOnly(2026, 2, 15));
            Click(window, "Apply ledger filters");
            Dispatcher.UIThread.RunJobs();

            var visible = VisibleWindowText(window);
            Assert.Contains("Alpha Subscription", visible);
            Assert.DoesNotContain("Alpha Market", visible);
            Assert.DoesNotContain("Salary", visible);

            Click(window, "Reset ledger filters");
            Dispatcher.UIThread.RunJobs();
            visible = VisibleWindowText(window);
            Assert.Contains("Alpha Market", visible);
            Assert.Contains("Alpha Subscription", visible);
            Assert.Contains("Salary", visible);
            window.Close();
        }, CancellationToken.None);
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (File.Exists(_databasePath)) File.Delete(_databasePath);
    }

    private static void ClickNavigation(Window window, string name)
    {
        Click(window, name);
    }

    private static void Click(Window window, string name)
    {
        var button = window.GetVisualDescendants().OfType<Button>().Single(control => Avalonia.Automation.AutomationProperties.GetName(control) == name);
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    }

    private static void SetText(Window window, string name, string value) =>
        window.GetVisualDescendants().OfType<TextBox>().Single(control => Avalonia.Automation.AutomationProperties.GetName(control) == name).Text = value;

    private static void SetDate(Window window, string name, DateOnly value) =>
        window.GetVisualDescendants().OfType<DatePicker>().Single(control => Avalonia.Automation.AutomationProperties.GetName(control) == name).SelectedDate =
            new DateTimeOffset(value.ToDateTime(TimeOnly.MinValue));

    private static void SetChecked(Window window, string name, bool value) =>
        window.GetVisualDescendants().OfType<CheckBox>().Single(control => Avalonia.Automation.AutomationProperties.GetName(control) == name).IsChecked = value;

    private static string WindowText(Window window) => string.Join("\n", window.GetVisualDescendants().OfType<TextBlock>().Select(textBlock => textBlock.Text));

    private static string VisibleWindowText(Window window) => string.Join("\n", window.GetVisualDescendants().OfType<TextBlock>()
        .Where(textBlock => textBlock.IsEffectivelyVisible).Select(textBlock => textBlock.Text));
}
