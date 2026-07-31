using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using FamilyFinance.Data;
using FamilyFinance.Domain;

namespace FamilyFinance.App;

public sealed partial class MainWindow : Window
{
    private static readonly IBrush RailBrush = Brush.Parse("#111720");
    private static readonly IBrush SurfaceBrush = Brush.Parse("#171E28");
    private static readonly IBrush SurfaceRaisedBrush = Brush.Parse("#1D2633");
    private static readonly IBrush TableHeaderBrush = Brush.Parse("#242F3E");
    private readonly LedgerRepository _ledger;
    private static readonly HttpClient BrokerClient = new() { Timeout = TimeSpan.FromSeconds(30) };
    private const string SandboxBrokerUrl = "https://family-finance-broker.cloud-admin-f91.workers.dev/v1/sandbox/demo-transactions";
    private readonly ContentControl _content = new();
    private readonly TextBlock _title = new() { FontSize = 26, FontWeight = FontWeight.SemiBold, VerticalAlignment = VerticalAlignment.Center };
    private readonly HashSet<RecurringSuggestionKey> _dismissedRecurringSuggestions = [];
    // Posting removes an occurrence from the persisted projection immediately. Keep its row in
    // the current Scheduled transactions session so the result of Record is visible to the user.
    private readonly HashSet<ScheduledOccurrenceKey> _recordedScheduledOccurrences = [];
    private DateOnly _calendarMonth = new(DateTime.Today.Year, DateTime.Today.Month, 1);
    private Action? _refreshCurrentView;
    private Flyout? _calendarDateFlyout;
    private int? _dashboardRangeMonths = 1;

    public MainWindow() : this(CreateDefaultLedger())
    {
    }

    public MainWindow(LedgerRepository ledger)
    {
        InitializeComponent();
        _ledger = ledger ?? throw new ArgumentNullException(nameof(ledger));

        Content = BuildShell();
        ShowDashboard();
    }

    private static LedgerRepository CreateDefaultLedger()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FamilyFinance");
        Directory.CreateDirectory(folder);
        var database = new LocalDatabase(Path.Combine(folder, "family-finance.db"));
        database.Initialize();
        return new LedgerRepository(database);
    }

    private Control BuildShell()
    {
        var navigation = new StackPanel { Spacing = 8, Margin = new Thickness(10) };
        navigation.Children.Add(NavButton("▦", "Dashboard", ShowDashboard));
        navigation.Children.Add(NavButton("□", "Calendar", ShowCalendar));
        navigation.Children.Add(NavButton("☷", "Ledger", ShowLedger));
        navigation.Children.Add(NavButton("◎", "Accounts", ShowAccounts));
        navigation.Children.Add(NavButton("⌁", "Scenarios", ShowScenarios));
        navigation.Children.Add(NavButton("AI", "AI", ShowAi));

        navigation.Children.Add(NavButton("#", "Categories", ShowCategories));
        navigation.Children.Add(NavButton("~", "Scheduled transactions", ShowScheduledTransactions));

        var header = new DockPanel { Margin = new Thickness(32, 28, 32, 0) };
        header.Children.Add(_title);
        var add = new Button { Content = "Add transaction", HorizontalAlignment = HorizontalAlignment.Right };
        AutomationProperties.SetName(add, "Add transaction");
        add.Click += async (_, _) => await ShowTransactionDialog();
        DockPanel.SetDock(add, Dock.Right);
        header.Children.Add(add);

        var main = new Grid { RowDefinitions = new RowDefinitions("Auto,*") };
        main.Children.Add(header);
        _content.Margin = new Thickness(32, 26, 32, 28);
        Grid.SetRow(_content, 1);
        main.Children.Add(_content);

        // Keep an acrylic backdrop, but always draw a dark tinted base under application content.
        // A fully transparent root lets arbitrary desktop/browser colors destroy text contrast.
        var root = new Grid { ColumnDefinitions = new ColumnDefinitions("64,*"), Background = Brush.Parse("#2A313B") };
        root.Children.Add(new Border { Background = RailBrush, Child = navigation });
        Grid.SetColumn(main, 1);
        root.Children.Add(main);
        return root;
    }

    private Button NavButton(string icon, string name, Action action)
    {
        var button = new Button
        {
            Content = icon,
            FontSize = 18,
            Width = 40,
            Height = 40,
            Padding = new Thickness(0),
            HorizontalContentAlignment = HorizontalAlignment.Center,
            VerticalContentAlignment = VerticalAlignment.Center
        };
        ToolTip.SetTip(button, name);
        AutomationProperties.SetName(button, name);
        button.Click += (_, _) => action();
        return button;
    }

    private void ShowDashboard()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowDashboard;
        _title.Text = "Dashboard";
        var accounts = _ledger.GetAccounts();
        var transactions = _ledger.GetTransactions();
        var now = DateOnly.FromDateTime(DateTime.Today);
        var projectionDate = now.AddMonths(3);
        var projectedOccurrences = _ledger.GetScheduledOccurrences(now, projectionDate);
        var rangeStart = DashboardRangeStart(transactions, now, _dashboardRangeMonths);
        var periodTransactions = transactions.Where(item => item.Date >= rangeStart && item.Date <= now).ToArray();
        var income = periodTransactions.Where(item => item.Amount.Amount > 0).Sum(item => item.Amount.Amount);
        var spending = -periodTransactions.Where(item => item.Amount.Amount < 0).Sum(item => item.Amount.Amount);
        var currentNetWorth = accounts.Sum(account => AccountBalanceCalculator.Calculate(account, transactions, now).Amount);
        var panel = new StackPanel { Spacing = 26 };
        var hero = new Grid { ColumnDefinitions = new ColumnDefinitions("1.7*,*"), ColumnSpacing = 16 };
        var netWorth = new StackPanel { Spacing = 6 };
        netWorth.Children.Add(new TextBlock { Text = "NET WORTH", FontSize = 11, FontWeight = FontWeight.SemiBold, Opacity = .58 });
        netWorth.Children.Add(new TextBlock { Text = Format(currentNetWorth), FontSize = 34, FontWeight = FontWeight.Bold });
        netWorth.Children.Add(new TextBlock { Text = "Across all local accounts", Opacity = .62, FontSize = 12 });
        netWorth.Children.Add(NetWorthSparkline(accounts, transactions, rangeStart, now));
        hero.Children.Add(new Border { Background = SurfaceBrush, BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(20), Child = netWorth });
        var month = new StackPanel { Spacing = 12 };
        month.Children.Add(new TextBlock { Text = DashboardRangeLabel(_dashboardRangeMonths), FontSize = 11, FontWeight = FontWeight.SemiBold, Opacity = .58 });
        month.Children.Add(CompactMetric("Income", income, Brush.Parse("#48C78E")));
        month.Children.Add(CompactMetric("Spending", spending, Brush.Parse("#F08A78")));
        var periodButtons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 4, 0, 0) };
        foreach (var (label, months) in new (string Label, int? Months)[] { ("1M", 1), ("3M", 3), ("6M", 6), ("1Y", 12), ("ALL", null) })
        {
            var button = new Button { Content = label, FontSize = 11, Padding = new Thickness(9, 4), Background = _dashboardRangeMonths == months ? Brush.Parse("#335D99") : Brush.Parse("#202936") };
            button.Click += (_, _) => { _dashboardRangeMonths = months; ShowDashboard(); };
            periodButtons.Children.Add(button);
        }
        month.Children.Add(periodButtons);
        var monthCard = new Border { Background = SurfaceRaisedBrush, BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(20), Child = month };
        Grid.SetColumn(monthCard, 1);
        hero.Children.Add(monthCard);
        panel.Children.Add(hero);
        var accountsWidget = new StackPanel { Spacing = 12 };
        accountsWidget.Children.Add(new TextBlock { Text = "Accounts & cards", FontSize = 16, FontWeight = FontWeight.SemiBold });
        if (accounts.Count == 0)
        {
            accountsWidget.Children.Add(Empty("No accounts yet. Add an account to begin tracking balances.", "Add account", ShowAccounts));
        }
        else
        {
            var accountCards = new WrapPanel { ItemSpacing = 12, LineSpacing = 12 };
            foreach (var account in accounts)
            {
                var projection = AccountBalanceProjector.Calculate(account, transactions, projectedOccurrences, projectionDate);
                accountCards.Children.Add(new Border
                {
                    Width = 270, Padding = new Thickness(16, 14), CornerRadius = new CornerRadius(9),
                    Background = SurfaceBrush,
                    BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1),
                    Child = new StackPanel
                    {
                        Spacing = 5,
                        Children =
                        {
                            new TextBlock { Text = account.Type == AccountType.CreditCard ? "CREDIT CARD" : account.Type.ToString().ToUpperInvariant(), FontSize = 10, FontWeight = FontWeight.SemiBold, Opacity = .58 },
                            new TextBlock { Text = account.Name, FontWeight = FontWeight.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis },
                            new TextBlock { Text = Format(projection.LedgerBalance.Amount), FontSize = 22, FontWeight = FontWeight.Bold, Margin = new Thickness(0, 7, 0, 0) },
                            new TextBlock { Text = $"Projected {projectionDate:MMM d}: {Format(projection.ProjectedBalance.Amount)}", Opacity = .62, FontSize = 11 }
                        }
                    }
                });
            }
            accountsWidget.Children.Add(accountCards);
        }
        panel.Children.Add(new Border { Background = SurfaceBrush, BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(16), Child = accountsWidget });
        var schedules = _ledger.GetScheduledTransactions();
        var suggestions = RecurringTransactionDetector.Detect(transactions)
            .Where(suggestion => !_dismissedRecurringSuggestions.Contains(RecurringSuggestionKey.From(suggestion)))
            .Where(suggestion => !schedules.Any(schedule =>
                schedule.AccountId == suggestion.AccountId &&
                schedule.Amount == suggestion.Amount &&
                schedule.Recurrence == suggestion.Recurrence &&
                RecurringTransactionDetector.NormalizeDescription(schedule.Description) == suggestion.NormalizedDescription))
            .ToArray();
        var suggestionsWidget = new StackPanel { Spacing = 9 };
        suggestionsWidget.Children.Add(new TextBlock { Text = "Recurring suggestions", FontSize = 16, FontWeight = FontWeight.SemiBold });
        if (suggestions.Length == 0)
        {
            // Empty review widgets intentionally collapse.
        }
        else
        {
            var accountNames = accounts.ToDictionary(account => account.Id, account => account.Name);
            var transactionById = transactions.ToDictionary(transaction => transaction.Id);
            foreach (var suggestion in suggestions)
            {
                var evidenceDates = suggestion.SourceTransactionIds
                    .Select(id => transactionById[id].Date.ToString("MMM d", CultureInfo.CurrentCulture));
                var card = new StackPanel { Spacing = 5 };
                card.Children.Add(new TextBlock { Text = suggestion.Description, FontWeight = FontWeight.SemiBold });
                card.Children.Add(new TextBlock
                {
                    Text = $"{accountNames.GetValueOrDefault(suggestion.AccountId, "Unknown account")} / {Format(suggestion.Amount.Amount)} / {suggestion.Recurrence}",
                    Opacity = .7
                });
                card.Children.Add(new TextBlock { Text = $"Evidence: {string.Join(", ", evidenceDates)}", Opacity = .7 });
                card.Children.Add(new TextBlock { Text = $"Next occurrence: {suggestion.NextOccurrenceDate:MMM d, yyyy}", Opacity = .7 });
                var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                var accept = new Button { Content = "Add schedule" };
                AutomationProperties.SetName(accept, $"Add suggested schedule {suggestion.Description}");
                accept.Click += async (_, _) => await ShowScheduledTransactionDialog(suggestion);
                actions.Children.Add(accept);
                var dismiss = new Button { Content = "Dismiss" };
                AutomationProperties.SetName(dismiss, $"Dismiss suggested schedule {suggestion.Description}");
                dismiss.Click += (_, _) =>
                {
                    _dismissedRecurringSuggestions.Add(RecurringSuggestionKey.From(suggestion));
                    ShowDashboard();
                };
                actions.Children.Add(dismiss);
                card.Children.Add(actions);
                suggestionsWidget.Children.Add(new Border { Background = SurfaceRaisedBrush, Padding = new Thickness(14, 12), CornerRadius = new CornerRadius(8), Child = card });
            }
        }
        if (suggestions.Length > 0)
        {
            panel.Children.Add(new Border { Background = SurfaceBrush, BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(16), Child = suggestionsWidget });
        }
        var upcoming = projectedOccurrences.Take(5).ToArray();
        var upcomingWidget = new StackPanel { Spacing = 10 };
        upcomingWidget.Children.Add(new TextBlock { Text = "Upcoming", FontSize = 16, FontWeight = FontWeight.SemiBold });
        if (upcoming.Length == 0)
        {
            upcomingWidget.Children.Add(Empty("No scheduled transactions coming up.", "Add scheduled transaction", ShowScheduledTransactions));
        }
        else
        {
            foreach (var occurrence in upcoming)
            {
                var row = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), ColumnSpacing = 10 };
                row.Children.Add(new TextBlock { Text = occurrence.Date.ToString("MMM d"), Opacity = .62, VerticalAlignment = VerticalAlignment.Center });
                var description = new TextBlock { Text = occurrence.Schedule.Description, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(description, 1);
                row.Children.Add(description);
                var amount = new TextBlock { Text = Format(occurrence.Schedule.Amount.Amount), FontWeight = FontWeight.SemiBold, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(amount, 2);
                row.Children.Add(amount);
                upcomingWidget.Children.Add(row);
            }
        }
        panel.Children.Add(new Border { Background = SurfaceBrush, BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(16), Child = upcomingWidget });
        _content.Content = new ScrollViewer { Content = panel, Offset = new Vector(0, 0) };
    }

    private static Border Summary(string label, decimal value) => new()
    {
        Background = SurfaceBrush, Padding = new Thickness(18),
        BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8),
        Child = new StackPanel { Spacing = 5, Children = { new TextBlock { Text = label, Opacity = .7 }, new TextBlock { Text = Format(value), FontSize = 23, FontWeight = FontWeight.SemiBold } } }
    };

    private static Border CompactMetric(string label, decimal value, IBrush accent) => new()
    {
        Background = Brush.Parse("#121923"), CornerRadius = new CornerRadius(7), Padding = new Thickness(12, 9),
        Child = new DockPanel
        {
            Children =
            {
                new TextBlock { Text = label, Opacity = .66, VerticalAlignment = VerticalAlignment.Center },
                new TextBlock { Text = Format(value), Foreground = accent, FontWeight = FontWeight.SemiBold, HorizontalAlignment = HorizontalAlignment.Right }
            }
        }
    };

    private static DateOnly DashboardRangeStart(IReadOnlyList<Transaction> transactions, DateOnly now, int? months)
    {
        if (months is null)
        {
            return transactions.Count == 0 ? now : transactions.Min(item => item.Date);
        }

        return now.AddMonths(-months.Value).AddDays(1);
    }

    private static string DashboardRangeLabel(int? months) => months switch
    {
        1 => "LAST 1 MONTH",
        3 => "LAST 3 MONTHS",
        6 => "LAST 6 MONTHS",
        12 => "LAST 1 YEAR",
        _ => "ALL ACTIVITY"
    };

    private static Control NetWorthSparkline(IReadOnlyList<Account> accounts, IReadOnlyList<Transaction> transactions, DateOnly start, DateOnly end)
    {
        const double width = 420;
        const double height = 94;
        var baseline = accounts.Sum(account => account.OpeningBalance.Amount) +
            transactions.Where(item => item.Date < start).Sum(item => item.Amount.Amount);
        var points = new List<(DateOnly Date, decimal Balance)> { (start, baseline) };
        foreach (var transaction in transactions.Where(item => item.Date >= start && item.Date <= end).OrderBy(item => item.Date))
        {
            baseline += transaction.Amount.Amount;
            points.Add((transaction.Date, baseline));
        }
        if (points.Count == 1) points.Add((end, baseline));
        var min = points.Min(point => point.Balance);
        var max = points.Max(point => point.Balance);
        var range = Math.Max(max - min, 1m);
        var first = points[0].Date;
        var days = Math.Max(end.DayNumber - first.DayNumber, 1);
        var linePoints = new Points(points.Select(point => new Point(
            2 + (point.Date.DayNumber - first.DayNumber) * (width - 4) / days,
            height - 8 - (double)((point.Balance - min) * (decimal)(height - 18) / range))));
        return new Avalonia.Controls.Shapes.Polyline
        {
            Points = linePoints,
            Stroke = Brush.Parse("#69D0FF"),
            StrokeThickness = 2.5,
            Width = width,
            Height = height,
            Margin = new Thickness(0, 12, 0, 0)
        };
    }

    private Control Empty(string text, string actionText, Action action)
    {
        var box = new StackPanel { Spacing = 10 };
        box.Children.Add(new TextBlock { Text = text, Opacity = .7 });
        var button = new Button { Content = actionText, HorizontalAlignment = HorizontalAlignment.Left };
        button.Click += (_, _) => action(); box.Children.Add(button);
        return box;
    }

    private void ShowAccounts()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowAccounts;
        _title.Text = "Accounts";
        var panel = new StackPanel { Spacing = 12 };
        var add = new Button { Content = "Add account", HorizontalAlignment = HorizontalAlignment.Left };
        add.Click += async (_, _) => await ShowAccountDialog();
        panel.Children.Add(add);
        var import = new Button { Content = "Import Plaid Sandbox transactions", HorizontalAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetName(import, "Import Plaid Sandbox transactions");
        import.Click += async (_, _) => await ImportPlaidSandboxTransactions();
        panel.Children.Add(import);
        var transactions = _ledger.GetTransactions();
        foreach (var account in _ledger.GetAccounts())
        {
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("2*,*,*,Auto"), Margin = new Thickness(0, 6), ColumnSpacing = 10 };
            row.Children.Add(new TextBlock { Text = account.Name });
            var type = new TextBlock { Text = account.Type.ToString(), Opacity = .7 }; Grid.SetColumn(type, 1); row.Children.Add(type);
            var balance = new TextBlock { Text = Format(AccountBalanceCalculator.Calculate(account, transactions).Amount), HorizontalAlignment = HorizontalAlignment.Right }; Grid.SetColumn(balance, 2); row.Children.Add(balance);
            var adjust = new Button { Content = "Adjust balance", Padding = new Thickness(8, 3) };
            AutomationProperties.SetName(adjust, $"Adjust balance for {account.Name}");
            adjust.Click += async (_, _) => await ShowBalanceAdjustmentDialog(account);
            Grid.SetColumn(adjust, 3); row.Children.Add(adjust);
            panel.Children.Add(row);
        }
        if (!panel.Children.OfType<Grid>().Any()) panel.Children.Add(new TextBlock { Text = "No accounts yet.", Opacity = .7 });
        _content.Content = new ScrollViewer { Content = panel };
    }

    private async Task ImportPlaidSandboxTransactions()
    {
        try
        {
            using var response = await BrokerClient.GetAsync(SandboxBrokerUrl);
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var root = document.RootElement;
            var connection = root.GetProperty("connection");
            var connectionId = connection.GetProperty("id").GetString()!;
            var institutionName = connection.GetProperty("institutionName").GetString() ?? "Plaid Sandbox";
            var localAccounts = _ledger.GetAccounts().ToList();
            var legacySandboxAccount = localAccounts.FirstOrDefault(item => item.Name == institutionName + " Checking");
            var hasCurrentSandboxAccounts = localAccounts.Any(item => item.Name.StartsWith(institutionName + " • ", StringComparison.Ordinal));
            if (legacySandboxAccount is not null && !hasCurrentSandboxAccounts)
            {
                // Upgrade the original one-account demo import to Plaid's real Sandbox account model.
                _ledger.ClearImportedConnection(connectionId);
                _ledger.DeleteAccount(legacySandboxAccount.Id);
                localAccounts.Remove(legacySandboxAccount);
            }
            var accountsByProviderId = new Dictionary<string, Account>(StringComparer.Ordinal);
            foreach (var providerAccount in root.GetProperty("accounts").EnumerateArray())
            {
                var providerAccountId = providerAccount.GetProperty("account_id").GetString();
                if (string.IsNullOrWhiteSpace(providerAccountId)) continue;
                var providerName = providerAccount.TryGetProperty("official_name", out var officialName) && officialName.ValueKind == JsonValueKind.String
                    ? officialName.GetString() : providerAccount.GetProperty("name").GetString();
                var localName = institutionName + " • " + (providerName ?? "Account");
                var account = localAccounts.FirstOrDefault(item => item.Name == localName);
                if (account is null)
                {
                    var type = providerAccount.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
                    var subtype = providerAccount.TryGetProperty("subtype", out var subtypeValue) ? subtypeValue.GetString() : null;
                    account = new Account(Guid.NewGuid(), localName, PlaidAccountType(type, subtype), new Money(0m));
                    _ledger.CreateAccount(account);
                    localAccounts.Add(account);
                }
                accountsByProviderId[providerAccountId] = account;
            }

            var imported = 0;
            foreach (var item in root.GetProperty("added").EnumerateArray().Concat(root.GetProperty("modified").EnumerateArray()))
            {
                if (!item.TryGetProperty("transaction_id", out var idValue) || !item.TryGetProperty("date", out var dateValue) || !item.TryGetProperty("amount", out var amountValue)) continue;
                var transactionId = idValue.GetString();
                if (string.IsNullOrWhiteSpace(transactionId) || !DateOnly.TryParse(dateValue.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) continue;
                var description = item.TryGetProperty("merchant_name", out var merchant) && merchant.ValueKind == JsonValueKind.String
                    ? merchant.GetString() : item.TryGetProperty("name", out var name) ? name.GetString() : null;
                if (string.IsNullOrWhiteSpace(description)) description = "Imported transaction";
                var plaidAmount = amountValue.GetDecimal();
                if (plaidAmount == 0m) continue;
                var providerAccountId = item.TryGetProperty("account_id", out var accountIdValue) ? accountIdValue.GetString() : null;
                if (string.IsNullOrWhiteSpace(providerAccountId) || !accountsByProviderId.TryGetValue(providerAccountId, out var account)) continue;
                var entry = new Transaction(Guid.NewGuid(), account.Id, date, description, new Money(-plaidAmount), null,
                    "Imported from Plaid Sandbox", DateTimeOffset.UtcNow);
                if (_ledger.TryImportTransaction("plaid", transactionId, connectionId, entry)) imported++;
            }

            await Message("Plaid Sandbox import", imported == 0
                ? "No new test transactions were available. Existing imported records were left untouched."
                : $"Imported {imported} Plaid Sandbox transactions across {accountsByProviderId.Count} accounts.");
            ShowAccounts();
        }
        catch (Exception exception)
        {
            await Message("Plaid Sandbox import failed", exception.Message);
        }
    }

    private static AccountType PlaidAccountType(string? type, string? subtype) =>
        type?.ToLowerInvariant() switch
        {
            "credit" => AccountType.CreditCard,
            "investment" => AccountType.Investment,
            "depository" when subtype?.Equals("savings", StringComparison.OrdinalIgnoreCase) == true => AccountType.Savings,
            "depository" => AccountType.Checking,
            "loan" => AccountType.Other,
            _ => AccountType.Other
        };

    private async Task ShowAccountDialog()
    {
        var name = new TextBox { PlaceholderText = "Account name" };
        var type = new ComboBox { ItemsSource = Enum.GetValues<AccountType>(), SelectedIndex = 0 };
        var opening = new TextBox { Text = "0.00", PlaceholderText = "Opening balance" };
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var save = new Button { Content = "Save", HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = new Button { Content = "Cancel" };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, save } };
        var dialog = Dialog("Add account", new Control[] { Labelled("Name", name), Labelled("Type", type), Labelled("Opening balance", opening), error, buttons });
        cancel.Click += (_, _) => dialog.Close();
        save.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(name.Text) || !decimal.TryParse(opening.Text, NumberStyles.Number, CultureInfo.CurrentCulture, out var amount)) { error.Text = "Enter an account name and valid opening balance."; return; }
            try { _ledger.CreateAccount(new Account(Guid.NewGuid(), name.Text, (AccountType)type.SelectedItem!, new Money(amount))); dialog.Close(); ShowAccounts(); }
            catch (Exception ex) { error.Text = ex.Message; }
        };
        await dialog.ShowDialog(this);
    }

    private async Task ShowBalanceAdjustmentDialog(Account account)
    {
        var date = new DatePicker { SelectedDate = DateTimeOffset.Now };
        AutomationProperties.SetName(date, "Adjustment date");
        var initialDate = DateOnly.FromDateTime(date.SelectedDate!.Value.DateTime);
        var calculatedBalance = AccountBalanceCalculator.Calculate(account, _ledger.GetTransactions(account.Id), initialDate).Amount;
        var balance = new TextBox { Text = calculatedBalance.ToString("0.00", CultureInfo.CurrentCulture), PlaceholderText = "Actual account balance" };
        AutomationProperties.SetName(balance, "Actual account balance");
        var reason = new TextBox { PlaceholderText = "Why does the actual balance differ?", AcceptsReturn = true, Height = 60 };
        AutomationProperties.SetName(reason, "Adjustment reason");
        var difference = new TextBlock { Opacity = .7 };
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var save = new Button { Content = "Create adjustment", HorizontalAlignment = HorizontalAlignment.Right };
        AutomationProperties.SetName(save, "Create balance adjustment");
        var cancel = new Button { Content = "Cancel" };

        void UpdateDifference()
        {
            if (date.SelectedDate is null)
            {
                difference.Text = "Choose an adjustment date to calculate the ledger balance.";
                return;
            }

            var adjustmentDate = DateOnly.FromDateTime(date.SelectedDate.Value.DateTime);
            calculatedBalance = AccountBalanceCalculator.Calculate(account, _ledger.GetTransactions(account.Id), adjustmentDate).Amount;
            difference.Text = decimal.TryParse(balance.Text, NumberStyles.Number, CultureInfo.CurrentCulture, out var entered)
                ? $"Ledger balance as of {adjustmentDate:MMM d, yyyy}: {Format(calculatedBalance)}. Adjustment: {Format(entered - calculatedBalance)}."
                : $"Ledger balance as of {adjustmentDate:MMM d, yyyy}: {Format(calculatedBalance)}.";
        }

        balance.TextChanged += (_, _) => UpdateDifference();
        date.SelectedDateChanged += (_, _) => UpdateDifference();
        UpdateDifference();
        var dialog = Dialog($"Adjust {account.Name} balance", new Control[]
        {
            new TextBlock { Text = "This records an explicit adjustment transaction; it does not overwrite the ledger.", Opacity = .7, TextWrapping = TextWrapping.Wrap },
            Labelled("Actual balance", balance), difference, Labelled("Date", date), Labelled("Reason", reason), error,
            new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, save } }
        });

        cancel.Click += (_, _) => dialog.Close();
        save.Click += (_, _) =>
        {
            if (date.SelectedDate is null || !decimal.TryParse(balance.Text, NumberStyles.Number, CultureInfo.CurrentCulture, out var entered) || string.IsNullOrWhiteSpace(reason.Text))
            {
                error.Text = "Actual balance, date, and a reason are required.";
                return;
            }

            var adjustmentDate = DateOnly.FromDateTime(date.SelectedDate.Value.DateTime);
            calculatedBalance = AccountBalanceCalculator.Calculate(account, _ledger.GetTransactions(account.Id), adjustmentDate).Amount;
            var adjustment = entered - calculatedBalance;
            if (adjustment == 0m)
            {
                error.Text = "The actual balance already matches the ledger.";
                return;
            }

            try
            {
                _ledger.CreateTransaction(Transaction.CreateBalanceAdjustment(
                    Guid.NewGuid(),
                    account.Id,
                    adjustmentDate,
                    new Money(calculatedBalance),
                    new Money(entered),
                    reason.Text,
                    DateTimeOffset.UtcNow));
                dialog.Close();
                (_refreshCurrentView ?? ShowAccounts)();
            }
            catch (Exception ex)
            {
                error.Text = ex.Message;
            }
        };

        await dialog.ShowDialog(this);
    }

    private void ShowCategories()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowCategories;
        _title.Text = "Categories";

        var panel = new StackPanel { Spacing = 12 };
        var add = new Button { Content = "Add category", HorizontalAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetName(add, "Add category");
        add.Click += async (_, _) => await ShowCategoryDialog();
        panel.Children.Add(add);

        var categories = _ledger.GetCategories();
        if (categories.Count == 0)
        {
            panel.Children.Add(Empty("No categories yet. Add one to organize transactions.", "Add category", () => _ = ShowCategoryDialog()));
        }
        else
        {
            foreach (var category in categories)
            {
                panel.Children.Add(new Border
                {
                    Padding = new Thickness(14, 10),
                    Background = SurfaceBrush,
                    Child = new TextBlock { Text = category.Name }
                });
            }
        }

        _content.Content = new ScrollViewer { Content = panel };
    }

    private async Task ShowCategoryDialog()
    {
        var name = new TextBox { PlaceholderText = "Category name" };
        AutomationProperties.SetName(name, "Category name");
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var save = new Button { Content = "Save", HorizontalAlignment = HorizontalAlignment.Right };
        AutomationProperties.SetName(save, "Save category");
        var cancel = new Button { Content = "Cancel" };
        var dialog = Dialog("Add category", new Control[]
        {
            Labelled("Name", name), error,
            new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, save } }
        });

        cancel.Click += (_, _) => dialog.Close();
        save.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(name.Text))
            {
                error.Text = "A category name is required.";
                return;
            }

            try
            {
                _ledger.CreateCategory(new Category(Guid.NewGuid(), name.Text));
                dialog.Close();
                ShowCategories();
            }
            catch (Exception ex)
            {
                error.Text = ex.Message.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase)
                    ? "A category with that name already exists."
                    : ex.Message;
            }
        };

        await dialog.ShowDialog(this);
    }

    private void ShowScheduledTransactions()
    {
        _refreshCurrentView = ShowScheduledTransactions;
        _title.Text = "Scheduled transactions";
        var panel = new StackPanel { Spacing = 12 };
        var add = new Button { Content = "Add scheduled transaction", HorizontalAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetName(add, "Add scheduled transaction");
        add.Click += async (_, _) => await ShowScheduledTransactionDialog();
        panel.Children.Add(add);

        var accounts = _ledger.GetAccounts().ToDictionary(account => account.Id, account => account.Name);
        var categories = _ledger.GetCategories().ToDictionary(category => category.Id, category => category.Name);
        var schedules = _ledger.GetScheduledTransactions();
        if (schedules.Count == 0)
        {
            panel.Children.Add(Empty("No scheduled transactions yet. Add planned income or spending to see it in future dates.", "Add scheduled transaction", () => _ = ShowScheduledTransactionDialog()));
        }
        else
        {
            var today = DateOnly.FromDateTime(DateTime.Today);
            var through = today.AddMonths(3);
            var occurrences = _ledger.GetScheduledOccurrences(today, through)
                .GroupBy(occurrence => occurrence.Schedule.Id)
                .ToDictionary(group => group.Key, group => group.Take(5).ToArray());

            foreach (var schedule in schedules)
            {
                var card = new StackPanel { Spacing = 7 };
                card.Children.Add(new TextBlock { Text = schedule.Description, FontWeight = FontWeight.SemiBold });
                card.Children.Add(new TextBlock
                {
                    Text = $"{Format(schedule.Amount.Amount)} · {schedule.Recurrence} · starts {schedule.StartDate:MMM d, yyyy}" +
                           (schedule.EndDate is null ? string.Empty : $" · ends {schedule.EndDate:MMM d, yyyy}"),
                    Opacity = .7
                });
                var categoryName = schedule.CategoryId is Guid categoryId
                    ? categories.GetValueOrDefault(categoryId, "Uncategorized")
                    : "Uncategorized";
                card.Children.Add(new TextBlock { Text = $"{accounts.GetValueOrDefault(schedule.AccountId, "Unknown account")} · {categoryName}", Opacity = .7 });
                if (!string.IsNullOrWhiteSpace(schedule.Notes))
                {
                    card.Children.Add(new TextBlock { Text = schedule.Notes, Opacity = .7, TextWrapping = TextWrapping.Wrap });
                }

                var upcoming = occurrences.GetValueOrDefault(schedule.Id) ?? [];
                var confirmed = _recordedScheduledOccurrences
                    .Where(item => item.ScheduleId == schedule.Id)
                    .Select(item => new ScheduledTransactionOccurrence(schedule, item.Date))
                    .OrderBy(item => item.Date)
                    .ToArray();
                if (upcoming.Length > 0 || confirmed.Length > 0)
                {
                    card.Children.Add(new TextBlock { Text = "Upcoming occurrences", FontWeight = FontWeight.SemiBold, Margin = new Thickness(0, 4, 0, 0) });
                    foreach (var occurrence in upcoming)
                    {
                        var occurrenceRow = new DockPanel();
                        occurrenceRow.Children.Add(new TextBlock { Text = occurrence.Date.ToString("ddd, MMM d, yyyy"), VerticalAlignment = VerticalAlignment.Center });
                        var record = new Button { Content = "Record", Padding = new Thickness(8, 3), HorizontalAlignment = HorizontalAlignment.Right };
                        AutomationProperties.SetName(record, $"Record {schedule.Description} on {occurrence.Date:yyyy-MM-dd}");
                        record.Click += (_, _) => RecordScheduledOccurrence(occurrence);
                        DockPanel.SetDock(record, Dock.Right);
                        occurrenceRow.Children.Add(record);
                        var edit = new Button { Content = "Edit", Padding = new Thickness(8, 3), HorizontalAlignment = HorizontalAlignment.Right };
                        AutomationProperties.SetName(edit, $"Edit {schedule.Description} schedule on {occurrence.Date:yyyy-MM-dd}");
                        edit.Click += async (_, _) => await ShowScheduledTransactionDialog(existing: schedule);
                        DockPanel.SetDock(edit, Dock.Right);
                        occurrenceRow.Children.Add(edit);
                        var skip = new Button { Content = "Skip", Padding = new Thickness(8, 3), HorizontalAlignment = HorizontalAlignment.Right };
                        AutomationProperties.SetName(skip, $"Skip {schedule.Description} on {occurrence.Date:yyyy-MM-dd}");
                        skip.Click += async (_, _) => await ShowSkipOccurrenceDialog(occurrence);
                        DockPanel.SetDock(skip, Dock.Right);
                        occurrenceRow.Children.Add(skip);
                        card.Children.Add(occurrenceRow);
                    }

                    foreach (var occurrence in confirmed)
                    {
                        var occurrenceRow = new DockPanel();
                        occurrenceRow.Children.Add(new TextBlock { Text = occurrence.Date.ToString("ddd, MMM d, yyyy"), VerticalAlignment = VerticalAlignment.Center });
                        var added = new Button { Content = "Added", IsEnabled = false, Padding = new Thickness(8, 3), HorizontalAlignment = HorizontalAlignment.Right };
                        AutomationProperties.SetName(added, $"Added {schedule.Description} on {occurrence.Date:yyyy-MM-dd}");
                        DockPanel.SetDock(added, Dock.Right);
                        occurrenceRow.Children.Add(added);
                        var edit = new Button { Content = "Edit", Padding = new Thickness(8, 3), HorizontalAlignment = HorizontalAlignment.Right };
                        AutomationProperties.SetName(edit, $"Edit {schedule.Description} schedule on {occurrence.Date:yyyy-MM-dd}");
                        edit.Click += async (_, _) => await ShowScheduledTransactionDialog(existing: schedule);
                        DockPanel.SetDock(edit, Dock.Right);
                        occurrenceRow.Children.Add(edit);
                        card.Children.Add(occurrenceRow);
                    }
                }
                else
                {
                    card.Children.Add(new TextBlock { Text = "No upcoming occurrences in the next three months.", Opacity = .7 });
                }

                panel.Children.Add(new Border { Background = SurfaceBrush, Padding = new Thickness(14, 12), CornerRadius = new CornerRadius(8), Child = card });
            }
        }

        _content.Content = new ScrollViewer { Content = panel };
    }

    private async void RecordScheduledOccurrence(ScheduledTransactionOccurrence occurrence)
    {
        try
        {
            _ledger.PostScheduledOccurrence(occurrence.Schedule.Id, occurrence.Date, DateTimeOffset.UtcNow);
            _recordedScheduledOccurrences.Add(new ScheduledOccurrenceKey(occurrence.Schedule.Id, occurrence.Date));
            ShowScheduledTransactions();
        }
        catch (Exception ex)
        {
            await Message("Could not record scheduled transaction", ex.Message);
        }
    }

    private async Task ShowScheduledTransactionDialog(RecurringTransactionSuggestion? suggestion = null, ScheduledTransaction? existing = null)
    {
        var accounts = _ledger.GetAccounts();
        if (accounts.Count == 0)
        {
            await Message("Set up an account first", "Scheduled transactions need an account. Create one in Accounts first.");
            return;
        }

        var categories = _ledger.GetCategories();
        var selectedAccount = existing is not null
            ? accounts.SingleOrDefault(item => item.Id == existing.AccountId) ?? accounts[0]
            : suggestion is null ? accounts[0] : accounts.SingleOrDefault(item => item.Id == suggestion.AccountId) ?? accounts[0];
        var account = new ComboBox { ItemsSource = accounts, SelectedItem = selectedAccount };
        account.ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<Account>((value, _) => new TextBlock { Text = value.Name });
        AutomationProperties.SetName(account, "Scheduled transaction account");
        var start = new DatePicker { SelectedDate = existing is not null
            ? new DateTimeOffset(existing.StartDate.ToDateTime(TimeOnly.MinValue))
            : suggestion is null ? DateTimeOffset.Now : new DateTimeOffset(suggestion.NextOccurrenceDate.ToDateTime(TimeOnly.MinValue)) };
        AutomationProperties.SetName(start, "Scheduled transaction start date");
        var hasEndDate = new CheckBox { Content = "Set an end date", IsChecked = existing?.EndDate is not null };
        AutomationProperties.SetName(hasEndDate, "Set an end date");
        var end = new DatePicker { SelectedDate = existing?.EndDate is DateOnly endDate
            ? new DateTimeOffset(endDate.ToDateTime(TimeOnly.MinValue)) : DateTimeOffset.Now.AddMonths(1), IsVisible = existing?.EndDate is not null };
        AutomationProperties.SetName(end, "Scheduled transaction end date");
        hasEndDate.IsCheckedChanged += (_, _) => end.IsVisible = hasEndDate.IsChecked == true;
        var source = suggestion is null ? null : _ledger.GetTransactions()
            .Where(transaction => suggestion.SourceTransactionIds.Contains(transaction.Id))
            .OrderByDescending(transaction => transaction.Date)
            .ThenByDescending(transaction => transaction.CreatedAt)
            .FirstOrDefault();
        var description = new TextBox { Text = existing?.Description ?? suggestion?.Description };
        AutomationProperties.SetName(description, "Scheduled transaction description");
        var amount = new TextBox
        {
            PlaceholderText = "Income positive; spending negative",
            Text = existing is not null
                ? existing.Amount.Amount.ToString("0.00", CultureInfo.CurrentCulture)
                : suggestion?.Amount.Amount.ToString("0.00", CultureInfo.CurrentCulture)
        };
        AutomationProperties.SetName(amount, "Scheduled transaction amount");
        var categoryItems = new List<Category?>(categories) { null };
        var selectedCategoryId = existing?.CategoryId ?? source?.CategoryId;
        var category = new ComboBox { ItemsSource = categoryItems, SelectedItem = selectedCategoryId is Guid categoryId ? categories.SingleOrDefault(item => item.Id == categoryId) : null };
        category.ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<Category?>((value, _) => new TextBlock { Text = value?.Name ?? "Uncategorized" });
        AutomationProperties.SetName(category, "Scheduled transaction category");
        var recurrence = new ComboBox { ItemsSource = Enum.GetValues<ScheduledTransactionRecurrence>(), SelectedItem = existing?.Recurrence ?? suggestion?.Recurrence ?? ScheduledTransactionRecurrence.Monthly };
        AutomationProperties.SetName(recurrence, "Scheduled transaction recurrence");
        var notes = new TextBox { AcceptsReturn = true, Height = 60, Text = existing?.Notes ?? source?.Notes };
        AutomationProperties.SetName(notes, "Scheduled transaction notes");
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var save = new Button { Content = "Save", HorizontalAlignment = HorizontalAlignment.Right };
        AutomationProperties.SetName(save, "Save scheduled transaction");
        var cancel = new Button { Content = "Cancel" };
        var dialog = Dialog(existing is not null ? "Edit scheduled transaction" : suggestion is null ? "Add scheduled transaction" : "Review suggested schedule", new Control[]
        {
            Labelled("Account", account), Labelled("Start date", start), hasEndDate, Labelled("End date", end),
            Labelled("Description", description), Labelled("Amount", amount), Labelled("Category", category), Labelled("Repeat", recurrence), Labelled("Notes", notes), error,
            new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, save } }
        });

        cancel.Click += (_, _) => dialog.Close();
        save.Click += (_, _) =>
        {
            if (account.SelectedItem is not Account selected || start.SelectedDate is null || string.IsNullOrWhiteSpace(description.Text) ||
                !decimal.TryParse(amount.Text, NumberStyles.Number, CultureInfo.CurrentCulture, out var parsed) || parsed == 0m || recurrence.SelectedItem is not ScheduledTransactionRecurrence selectedRecurrence ||
                (hasEndDate.IsChecked == true && end.SelectedDate is null))
            {
                error.Text = "Account, start date, description, non-zero amount, and recurrence are required.";
                return;
            }

            try
            {
                var startDate = DateOnly.FromDateTime(start.SelectedDate.Value.DateTime);
                DateOnly? scheduledEndDate = hasEndDate.IsChecked == true ? DateOnly.FromDateTime(end.SelectedDate!.Value.DateTime) : null;
                if (existing is null)
                {
                    _ledger.CreateScheduledTransaction(new ScheduledTransaction(
                        Guid.NewGuid(), selected.Id, startDate, scheduledEndDate,
                        description.Text, new Money(parsed), (category.SelectedItem as Category)?.Id, notes.Text, selectedRecurrence, DateTimeOffset.UtcNow));
                }
                else
                {
                    _ledger.UpdateScheduledTransaction(existing.Edit(selected.Id, startDate, scheduledEndDate,
                        description.Text, new Money(parsed), (category.SelectedItem as Category)?.Id, notes.Text, selectedRecurrence));
                }
                dialog.Close();
                if (suggestion is null || existing is not null)
                {
                    ShowScheduledTransactions();
                }
                else
                {
                    ShowDashboard();
                }
            }
            catch (Exception ex)
            {
                error.Text = ex.Message;
            }
        };

        await dialog.ShowDialog(this);
    }

    private async Task ShowSkipOccurrenceDialog(ScheduledTransactionOccurrence occurrence)
    {
        var reason = new TextBox { PlaceholderText = "Optional reason" };
        AutomationProperties.SetName(reason, "Skip reason");
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var skip = new Button { Content = "Skip occurrence", HorizontalAlignment = HorizontalAlignment.Right };
        AutomationProperties.SetName(skip, "Confirm skip occurrence");
        var cancel = new Button { Content = "Cancel" };
        var dialog = Dialog("Skip scheduled occurrence", new Control[]
        {
            new TextBlock { Text = $"Skip {occurrence.Schedule.Description} on {occurrence.Date:MMM d, yyyy}? This leaves the schedule and all other occurrences intact.", TextWrapping = TextWrapping.Wrap },
            Labelled("Reason", reason), error,
            new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, skip } }
        });

        cancel.Click += (_, _) => dialog.Close();
        skip.Click += (_, _) =>
        {
            try
            {
                _ledger.SkipScheduledOccurrence(new ScheduledTransactionSkip(occurrence.Schedule.Id, occurrence.Date, DateTimeOffset.UtcNow, reason.Text));
                dialog.Close();
                ShowScheduledTransactions();
            }
            catch (Exception ex)
            {
                error.Text = ex.Message;
            }
        };

        await dialog.ShowDialog(this);
    }

    private void ShowLedger()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowLedger;
        _title.Text = "Ledger";
        var table = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,Auto,Auto,*"),
            RowSpacing = 10,
            HorizontalAlignment = HorizontalAlignment.Stretch
        };
        var toolbar = new DockPanel();
        var add = new Button { Content = "+  Add transaction", HorizontalAlignment = HorizontalAlignment.Left };
        add.Click += async (_, _) => await ShowTransactionDialog();
        toolbar.Children.Add(add);

        var rows = _ledger.GetLedgerTransactions();
        var search = new TextBox { PlaceholderText = "Name or description", Width = 190 };
        AutomationProperties.SetName(search, "Ledger name filter");
        var categoryOptions = new List<string> { "Any category", "Uncategorized" };
        categoryOptions.AddRange(_ledger.GetCategories().Select(item => item.Name));
        var category = new ComboBox { ItemsSource = categoryOptions, SelectedIndex = 0, MinWidth = 145 };
        AutomationProperties.SetName(category, "Ledger category filter");
        var minimumAmount = new TextBox { PlaceholderText = "Min amount", Width = 110 };
        AutomationProperties.SetName(minimumAmount, "Ledger minimum amount filter");
        var maximumAmount = new TextBox { PlaceholderText = "Max amount", Width = 110 };
        AutomationProperties.SetName(maximumAmount, "Ledger maximum amount filter");
        var fromDate = new DatePicker { Width = 145 };
        AutomationProperties.SetName(fromDate, "Ledger from date filter");
        ToolTip.SetTip(fromDate, "From date");
        var toDate = new DatePicker { Width = 145 };
        AutomationProperties.SetName(toDate, "Ledger to date filter");
        ToolTip.SetTip(toDate, "To date");
        var apply = new Button { Content = "Apply filters" };
        AutomationProperties.SetName(apply, "Apply ledger filters");
        var reset = new Button { Content = "Reset" };
        AutomationProperties.SetName(reset, "Reset ledger filters");
        var filterError = new TextBlock { Foreground = Brushes.Firebrick, VerticalAlignment = VerticalAlignment.Center };
        var filters = new WrapPanel { ItemSpacing = 8, LineSpacing = 8, HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var control in new Control[] { search, category, minimumAmount, maximumAmount, fromDate, toDate, apply, reset, filterError }) filters.Children.Add(control);
        var filterPanel = new Border { Background = SurfaceRaisedBrush, BorderBrush = Brush.Parse("#263243"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Child = filters, IsVisible = false };
        var filterToggle = new Button { Content = "Filters", HorizontalAlignment = HorizontalAlignment.Right };
        filterToggle.Click += (_, _) => filterPanel.IsVisible = !filterPanel.IsVisible;
        DockPanel.SetDock(filterToggle, Dock.Right);
        toolbar.Children.Add(filterToggle);
        table.Children.Add(toolbar);
        Grid.SetRow(filterPanel, 1);
        table.Children.Add(filterPanel);

        const string ledgerColumns = "130,2*,1.2*,1.2*,2*,120,160";
        var header = LedgerTableRow(ledgerColumns, TableHeaderBrush);
        AddLedgerCell(header, "Date", 0, FontWeight.SemiBold);
        AddLedgerCell(header, "Description", 1, FontWeight.SemiBold);
        AddLedgerCell(header, "Account", 2, FontWeight.SemiBold);
        AddLedgerCell(header, "Category", 3, FontWeight.SemiBold);
        AddLedgerCell(header, "Notes", 4, FontWeight.SemiBold);
        AddLedgerCell(header, "Amount", 5, FontWeight.SemiBold, HorizontalAlignment.Right);
        AddLedgerCell(header, "Actions", 6, FontWeight.SemiBold, HorizontalAlignment.Center);
        Grid.SetRow(header, 2);
        table.Children.Add(header);

        var body = new StackPanel { Spacing = 2, HorizontalAlignment = HorizontalAlignment.Stretch };
        if (rows.Count == 0)
        {
            body.Children.Add(new TextBlock
            {
                Text = "No transactions yet. Add a transaction after setting up an account.",
                Margin = new Thickness(9, 12)
            });
        }
        foreach (var entry in rows)
        {
            var row = LedgerTableRow(ledgerColumns, SurfaceBrush);
            AddLedgerCell(row, entry.Transaction.Date.ToString("MMM d, yyyy"), 0);
            var description = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(9, 7) };
            description.Children.Add(new TextBlock { Text = entry.Transaction.Description, TextTrimming = TextTrimming.CharacterEllipsis });
            if (entry.ScheduledPosting is not null)
            {
                description.Children.Add(new TextBlock
                {
                    Text = $"Posted from schedule · {entry.ScheduledPosting.OccurrenceDate:MMM d, yyyy}",
                    Opacity = .7,
                    FontSize = 12
                });
            }
            Grid.SetColumn(description, 1); row.Children.Add(description);
            AddLedgerCell(row, entry.AccountName, 2, opacity: .7);
            AddLedgerCell(row, entry.CategoryName ?? "Uncategorized", 3, opacity: .7);
            AddLedgerCell(row, entry.Transaction.Notes ?? string.Empty, 4, opacity: .7, wrapping: TextWrapping.Wrap);
            AddLedgerCell(row, Format(entry.Transaction.Amount.Amount), 5, FontWeight.SemiBold, HorizontalAlignment.Right);
            var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(9, 7) };
            if (entry.Transaction.Kind == TransactionKind.BalanceAdjustment)
            {
                description.Children.Add(new TextBlock { Text = "Balance adjustment - locked audit record", Opacity = .7, FontSize = 12 });
            }
            else
            {
                var edit = new Button { Content = "Edit" };
                ToolTip.SetTip(edit, "Edit transaction");
                AutomationProperties.SetName(edit, $"Edit {entry.Transaction.Description}");
                edit.Click += async (_, _) => await ShowTransactionDialog(entry.Transaction);
                actions.Children.Add(edit);
            }

            var delete = new Button { Content = "Delete", Foreground = Brushes.Firebrick };
            AutomationProperties.SetName(delete, $"Delete {entry.Transaction.Description}");
            ToolTip.SetTip(delete, "Delete transaction");
            delete.Click += async (_, _) => await ShowDeleteTransactionDialog(entry);
            actions.Children.Add(delete);
            Grid.SetColumn(actions, 6);
            row.Children.Add(actions);

            var record = new Border { Padding = new Thickness(0), Background = SurfaceBrush, Child = row, Tag = entry };
            if (entry.Transaction.Kind == TransactionKind.BalanceAdjustment)
            {
                ToolTip.SetTip(record, "Balance adjustments are audit records and cannot be edited from the ledger.");
                AutomationProperties.SetName(record, "Locked balance adjustment audit record");
            }
            body.Children.Add(record);
        }
        var bodyScroll = new ScrollViewer { Content = body, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Grid.SetRow(bodyScroll, 3);
        table.Children.Add(bodyScroll);

        void ApplyFilters()
        {
            if (!TryParseLedgerFilterAmount(minimumAmount.Text, "minimum", out var minimum, out var error) ||
                !TryParseLedgerFilterAmount(maximumAmount.Text, "maximum", out var maximum, out error))
            {
                filterError.Text = error;
                return;
            }
            if (minimum is not null && maximum is not null && minimum > maximum)
            {
                filterError.Text = "Minimum amount cannot be greater than maximum amount.";
                return;
            }
            var from = SelectedDateOnly(fromDate);
            var to = SelectedDateOnly(toDate);
            if (from is not null && to is not null && from > to)
            {
                filterError.Text = "From date cannot be after to date.";
                return;
            }
            filterError.Text = string.Empty;
            var name = search.Text?.Trim();
            var selectedCategory = category.SelectedItem as string;
            foreach (var record in body.Children.OfType<Border>())
            {
                var entry = (LedgerTransaction)record.Tag!;
                record.IsVisible =
                    (string.IsNullOrWhiteSpace(name) || entry.Transaction.Description.Contains(name, StringComparison.OrdinalIgnoreCase)) &&
                    (selectedCategory is null or "Any category" || (selectedCategory == "Uncategorized" ? entry.CategoryName is null : entry.CategoryName == selectedCategory)) &&
                    (minimum is null || entry.Transaction.Amount.Amount >= minimum) &&
                    (maximum is null || entry.Transaction.Amount.Amount <= maximum) &&
                    (from is null || entry.Transaction.Date >= from) &&
                    (to is null || entry.Transaction.Date <= to);
            }
        }
        apply.Click += (_, _) => ApplyFilters();
        reset.Click += (_, _) =>
        {
            search.Text = string.Empty;
            category.SelectedIndex = 0;
            minimumAmount.Text = string.Empty;
            maximumAmount.Text = string.Empty;
            fromDate.SelectedDate = null;
            toDate.SelectedDate = null;
            filterError.Text = string.Empty;
            foreach (var record in body.Children.OfType<Border>()) record.IsVisible = true;
        };
        _content.Content = table;
    }

    private static DateOnly? SelectedDateOnly(DatePicker picker) => picker.SelectedDate is DateTimeOffset value ? DateOnly.FromDateTime(value.DateTime) : null;

    private static bool TryParseLedgerFilterAmount(string? input, string label, out decimal? amount, out string? error)
    {
        amount = null;
        error = null;
        if (string.IsNullOrWhiteSpace(input)) return true;
        if (decimal.TryParse(input, NumberStyles.Number, CultureInfo.CurrentCulture, out var parsed))
        {
            amount = parsed;
            return true;
        }
        error = $"Enter a valid {label} amount.";
        return false;
    }

    private static Grid LedgerTableRow(string columnDefinitions, IBrush background)
    {
        return new Grid
        {
            ColumnDefinitions = new ColumnDefinitions(columnDefinitions),
            ColumnSpacing = 10,
            Background = background,
            HorizontalAlignment = HorizontalAlignment.Stretch
        };
    }

    private static void AddLedgerCell(Grid row, string text, int column, FontWeight? fontWeight = null,
        HorizontalAlignment horizontalAlignment = HorizontalAlignment.Left, double opacity = 1, TextWrapping wrapping = TextWrapping.NoWrap)
    {
        var cell = new TextBlock
        {
            Text = text,
            FontWeight = fontWeight ?? FontWeight.Normal,
            HorizontalAlignment = horizontalAlignment,
            VerticalAlignment = VerticalAlignment.Center,
            Opacity = opacity,
            TextWrapping = wrapping,
            TextTrimming = wrapping == TextWrapping.NoWrap ? TextTrimming.CharacterEllipsis : TextTrimming.None,
            Margin = new Thickness(9, 7)
        };
        Grid.SetColumn(cell, column);
        row.Children.Add(cell);
    }

    private async Task ShowDeleteTransactionDialog(LedgerTransaction entry)
    {
        var scheduleEffect = entry.ScheduledPosting is null
            ? ""
            : "\n\nThis entry was posted from a schedule. Deleting it keeps the schedule and makes the occurrence available to record again.";
        var message = $"Delete {entry.Transaction.Description} dated {entry.Transaction.Date:MMM d, yyyy} for {Format(entry.Transaction.Amount.Amount)}? This permanently removes the ledger record and cannot be undone.{scheduleEffect}";
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var cancel = new Button { Content = "Cancel" };
        AutomationProperties.SetName(cancel, "Cancel delete transaction");
        var delete = new Button { Content = "Delete", Foreground = Brushes.Firebrick };
        AutomationProperties.SetName(delete, "Confirm delete transaction");
        var dialog = Dialog("Delete transaction", new Control[]
        {
            new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
            error,
            new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, delete } }
        });
        cancel.Click += (_, _) => dialog.Close();
        delete.Click += (_, _) =>
        {
            try
            {
                _ledger.DeleteTransaction(entry.Transaction.Id);
                dialog.Close();
                (_refreshCurrentView ?? ShowLedger)();
            }
            catch (Exception ex)
            {
                error.Text = ex.Message;
            }
        };
        await dialog.ShowDialog(this);
    }

    private async Task ShowTransactionDialog(Transaction? existing = null)
    {
        var accounts = _ledger.GetAccounts();
        if (accounts.Count == 0) { await Message("Set up an account first", "Transactions need an account. Create one in Accounts first."); return; }
        var categories = _ledger.GetCategories();
        var account = new ComboBox { ItemsSource = accounts, SelectedItem = existing is null ? accounts[0] : accounts.Single(a => a.Id == existing.AccountId) };
        AutomationProperties.SetName(account, "Transaction account");
        account.ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<Account>((a, _) => new TextBlock { Text = a.Name });
        var date = new DatePicker { SelectedDate = existing is null ? DateTimeOffset.Now : existing.Date.ToDateTime(TimeOnly.MinValue) };
        AutomationProperties.SetName(date, "Transaction date");
        var description = new TextBox { Text = existing?.Description ?? "" };
        AutomationProperties.SetName(description, "Transaction description");
        var amount = new TextBox { Text = existing?.Amount.Amount.ToString("0.00", CultureInfo.CurrentCulture) ?? "", PlaceholderText = "Income positive; spending negative" };
        AutomationProperties.SetName(amount, "Transaction amount");
        var categoryItems = new List<Category?>(categories) { null };
        var category = new ComboBox { ItemsSource = categoryItems, SelectedItem = existing?.CategoryId is null ? null : categories.SingleOrDefault(c => c.Id == existing.CategoryId) };
        AutomationProperties.SetName(category, "Transaction category");
        category.ItemTemplate = new Avalonia.Controls.Templates.FuncDataTemplate<Category?>((c, _) => new TextBlock { Text = c?.Name ?? "Uncategorized" });
        var notes = new TextBox { Text = existing?.Notes ?? "", AcceptsReturn = true, Height = 60 };
        AutomationProperties.SetName(notes, "Transaction notes");
        var repeat = new CheckBox { Content = "Repeat this transaction" };
        AutomationProperties.SetName(repeat, "Repeat this transaction");
        var recurrence = new ComboBox
        {
            ItemsSource = Enum.GetValues<ScheduledTransactionRecurrence>(),
            SelectedItem = ScheduledTransactionRecurrence.Monthly,
            IsVisible = false
        };
        AutomationProperties.SetName(recurrence, "Transaction recurrence");
        var scheduleEndDate = new DatePicker { IsVisible = false };
        AutomationProperties.SetName(scheduleEndDate, "Transaction recurrence end date");
        var recurrenceFields = new StackPanel
        {
            Spacing = 8,
            IsVisible = false,
            Children =
            {
                Labelled("Repeat", recurrence),
                Labelled("Repeat through (optional)", scheduleEndDate)
            }
        };
        repeat.IsCheckedChanged += (_, _) => recurrenceFields.IsVisible = repeat.IsChecked == true;
        var error = new TextBlock { Foreground = Brushes.Firebrick, TextWrapping = TextWrapping.Wrap };
        var save = new Button { Content = existing is null ? "Add" : "Save", HorizontalAlignment = HorizontalAlignment.Right };
        AutomationProperties.SetName(save, "Save transaction");
        var cancel = new Button { Content = "Cancel" };
        var dialog = Dialog(existing is null ? "Add transaction" : "Edit transaction", new Control[] { Labelled("Account", account), Labelled("Date", date), Labelled("Description", description), Labelled("Amount", amount), Labelled("Category", category), Labelled("Notes", notes), repeat, recurrenceFields, error, new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Children = { cancel, save } } });
        cancel.Click += (_, _) => dialog.Close();
        save.Click += (_, _) =>
        {
            if (account.SelectedItem is not Account selected || date.SelectedDate is null || string.IsNullOrWhiteSpace(description.Text) || !decimal.TryParse(amount.Text, NumberStyles.Number, CultureInfo.CurrentCulture, out var parsed) || parsed == 0m) { error.Text = "Account, date, description, and a non-zero amount are required."; return; }
            try
            {
                var transactionDate = DateOnly.FromDateTime(date.SelectedDate.Value.DateTime);
                var entry = existing is null ? new Transaction(Guid.NewGuid(), selected.Id, transactionDate, description.Text, new Money(parsed), (category.SelectedItem as Category)?.Id, notes.Text, DateTimeOffset.UtcNow) : existing.Edit(selected.Id, transactionDate, description.Text, new Money(parsed), (category.SelectedItem as Category)?.Id, notes.Text);
                ScheduledTransaction? schedule = null;
                if (repeat.IsChecked == true)
                {
                    if (recurrence.SelectedItem is not ScheduledTransactionRecurrence selectedRecurrence)
                    {
                        error.Text = "Choose how often this transaction repeats.";
                        return;
                    }

                    var firstScheduledDate = NextScheduledOccurrence(transactionDate, selectedRecurrence);
                    DateOnly? endDate = scheduleEndDate.SelectedDate is null
                        ? null
                        : DateOnly.FromDateTime(scheduleEndDate.SelectedDate.Value.DateTime);
                    if (endDate is not null && endDate < firstScheduledDate)
                    {
                        error.Text = "The repeat end date must be on or after the first future occurrence.";
                        return;
                    }

                    schedule = new ScheduledTransaction(
                        Guid.NewGuid(), selected.Id, firstScheduledDate, endDate, description.Text, new Money(parsed),
                        (category.SelectedItem as Category)?.Id, notes.Text, selectedRecurrence, DateTimeOffset.UtcNow);
                }

                if (existing is null)
                {
                    if (schedule is null)
                    {
                        _ledger.CreateTransaction(entry);
                    }
                    else
                    {
                        _ledger.CreateTransactionWithSchedule(entry, schedule);
                    }
                }
                else
                {
                    if (schedule is null)
                    {
                        _ledger.UpdateTransaction(entry);
                    }
                    else
                    {
                        _ledger.UpdateTransactionWithSchedule(entry, schedule);
                    }
                }
                dialog.Close(); (_refreshCurrentView ?? ShowLedger)();
            }
            catch (Exception ex) { error.Text = ex.Message; }
        };
        await dialog.ShowDialog(this);
    }

    private static DateOnly NextScheduledOccurrence(DateOnly transactionDate, ScheduledTransactionRecurrence recurrence) => recurrence switch
    {
        ScheduledTransactionRecurrence.Daily => transactionDate.AddDays(1),
        ScheduledTransactionRecurrence.Weekly => transactionDate.AddDays(7),
        ScheduledTransactionRecurrence.Monthly => transactionDate.AddMonths(1),
        _ => throw new ArgumentOutOfRangeException(nameof(recurrence))
    };

    private void ShowCalendar()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowCalendar;
        _title.Text = "Calendar";
        // The header deliberately lives outside the swipe viewport. Only the date grid moves.
        var panel = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,*"),
            RowSpacing = 12,
            HorizontalAlignment = HorizontalAlignment.Stretch
        };
        // Month names vary in length; fixed columns keep the navigation controls stationary.
        var controls = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("40,200,40"),
            HorizontalAlignment = HorizontalAlignment.Center
        };
        var previous = new Button { Content = "‹", Width = 40, Height = 36 };
        AutomationProperties.SetName(previous, "Previous month");
        previous.Click += (_, _) => { _calendarMonth = _calendarMonth.AddMonths(-1); ShowCalendar(); };
        var month = new TextBlock
        {
            Text = _calendarMonth.ToString("MMMM yyyy", CultureInfo.CurrentCulture),
            FontSize = 18,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            TextAlignment = TextAlignment.Center
        };
        var next = new Button { Content = "›", Width = 40, Height = 36 };
        AutomationProperties.SetName(next, "Next month");
        next.Click += (_, _) => { _calendarMonth = _calendarMonth.AddMonths(1); ShowCalendar(); };
        controls.Children.Add(previous);
        Grid.SetColumn(month, 1);
        controls.Children.Add(month);
        Grid.SetColumn(next, 2);
        controls.Children.Add(next);
        panel.Children.Add(controls);
        var totals = FinancialSummaries.ForMonth(_ledger.GetTransactions(), _calendarMonth.Year, _calendarMonth.Month).ToDictionary(total => total.Date);
        var monthEnd = new DateOnly(_calendarMonth.Year, _calendarMonth.Month, DateTime.DaysInMonth(_calendarMonth.Year, _calendarMonth.Month));
        var today = DateOnly.FromDateTime(DateTime.Today);
        var scheduleStart = _calendarMonth.CompareTo(today) < 0 ? today : _calendarMonth;
        if (scheduleStart.CompareTo(monthEnd) <= 0)
        {
            foreach (var occurrence in _ledger.GetScheduledOccurrences(scheduleStart, monthEnd))
            {
                totals.TryGetValue(occurrence.Date, out var existing);
                var amount = occurrence.Schedule.Amount.Amount;
                totals[occurrence.Date] = new CalendarDaySummary(
                    occurrence.Date,
                    new Money((existing?.Income.Amount ?? 0m) + Math.Max(amount, 0m)),
                    new Money((existing?.Spending.Amount ?? 0m) + Math.Max(-amount, 0m)));
            }
        }
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*,*,*,*"), RowDefinitions = new RowDefinitions("Auto,*,*,*,*,*,*"), ColumnSpacing = 6, RowSpacing = 6 };
        var calendarTranslate = new TranslateTransform();
        grid.RenderTransform = calendarTranslate;
        var swipe = new CalendarSwipeState(calendarTranslate);
        var calendarViewport = new Border
        {
            Background = Brushes.Transparent,
            ClipToBounds = true,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Child = grid
        };
        calendarViewport.AddHandler(InputElement.PointerPressedEvent, (sender, args) =>
        {
            swipe.Begin(args.GetPosition(calendarViewport).X);
            args.Pointer.Capture(calendarViewport);
        }, handledEventsToo: true);
        calendarViewport.PointerMoved += (_, args) =>
            swipe.Move(args.GetPosition(calendarViewport).X, calendarViewport.Bounds.Width);
        calendarViewport.PointerReleased += (_, args) =>
        {
            var monthOffset = swipe.End(args.GetPosition(calendarViewport).X, calendarViewport.Bounds.Width);

            if (monthOffset != 0)
            {
                _calendarDateFlyout?.Hide();
                var exitX = monthOffset > 0 ? -calendarViewport.Bounds.Width : calendarViewport.Bounds.Width;
                AnimateCalendarTranslation(calendarTranslate, exitX, TimeSpan.FromMilliseconds(420), () =>
                {
                    _calendarMonth = _calendarMonth.AddMonths(monthOffset);
                    ShowCalendar();
                });
            }
            else if (swipe.PressedDate is { } pressedDate && !swipe.Dragged)
            {
                ShowCalendarDateFlyout(swipe.PressedDateAnchor!, pressedDate);
            }
            else
            {
                AnimateCalendarTranslation(calendarTranslate, 0d, TimeSpan.FromMilliseconds(460));
            }

            args.Pointer.Capture(null);
            swipe.ClearPressedDate();
        };
        calendarViewport.PointerCaptureLost += (_, _) => swipe.Cancel();
        foreach (var (label, column) in new[] { ("Sun", 0), ("Mon", 1), ("Tue", 2), ("Wed", 3), ("Thu", 4), ("Fri", 5), ("Sat", 6) }) { var heading = new TextBlock { Text = label, HorizontalAlignment = HorizontalAlignment.Center, FontWeight = FontWeight.SemiBold }; Grid.SetColumn(heading, column); grid.Children.Add(heading); }
        var firstColumn = (int)_calendarMonth.DayOfWeek;
        for (var day = 1; day <= DateTime.DaysInMonth(_calendarMonth.Year, _calendarMonth.Month); day++)
        {
            var current = new DateOnly(_calendarMonth.Year, _calendarMonth.Month, day); var index = firstColumn + day - 1; var cell = new StackPanel { Spacing = 3, Margin = new Thickness(5) }; cell.Children.Add(new TextBlock { Text = day.ToString(), FontWeight = FontWeight.SemiBold });
            if (totals.TryGetValue(current, out var total))
            {
                if (total.Income.Amount > 0m) cell.Children.Add(new TextBlock { Text = $"+{Format(total.Income.Amount)}", Foreground = Brushes.ForestGreen, FontSize = 11 });
                if (total.Spending.Amount > 0m) cell.Children.Add(new TextBlock { Text = $"-{Format(total.Spending.Amount)}", Foreground = Brushes.Firebrick, FontSize = 11 });
            }
            var border = new Border { Background = SurfaceRaisedBrush, MinHeight = 78, CornerRadius = new CornerRadius(4), Child = cell };
            AutomationProperties.SetName(border, $"Calendar date {current:yyyy-MM-dd}");
            border.PointerPressed += (_, _) => swipe.SetPressedDate(border, current);
            Grid.SetColumn(border, index % 7); Grid.SetRow(border, 1 + index / 7); grid.Children.Add(border);
        }
        Grid.SetRow(calendarViewport, 1);
        panel.Children.Add(calendarViewport);
        _content.Content = new ScrollViewer
        {
            Content = panel,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalContentAlignment = HorizontalAlignment.Stretch
        };
    }

    private static void AnimateCalendarTranslation(TranslateTransform transform, double targetX, TimeSpan duration, Action? completed = null)
    {
        var initialX = transform.X;
        if (Math.Abs(targetX - initialX) < 0.1d)
        {
            transform.X = targetX;
            completed?.Invoke();
            return;
        }

        var stopwatch = Stopwatch.StartNew();
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        timer.Tick += (_, _) =>
        {
            var linear = Math.Min(stopwatch.Elapsed.TotalMilliseconds / duration.TotalMilliseconds, 1d);
            var eased = 1d - Math.Pow(1d - linear, 3d);
            transform.X = initialX + ((targetX - initialX) * eased);
            if (linear >= 1d)
            {
                timer.Stop();
                completed?.Invoke();
            }
        };
        timer.Start();
    }

    private void ShowCalendarDateFlyout(Control anchor, DateOnly date)
    {
        _calendarDateFlyout?.Hide();

        var entries = _ledger.GetLedgerTransactions().Where(entry => entry.Transaction.Date == date).ToArray();
        var content = new StackPanel
        {
            Spacing = 10,
            Margin = new Thickness(16),
            Width = 400,
            MinWidth = 360,
            MaxWidth = 460
        };
        content.Children.Add(new TextBlock
        {
            Text = date.ToString("dddd, MMMM d, yyyy", CultureInfo.CurrentCulture),
            FontSize = 14,
            FontWeight = FontWeight.SemiBold
        });
        if (entries.Length == 0)
        {
            content.Children.Add(new TextBlock { Text = "No recorded transactions.", Opacity = .7 });
        }
        else
        {
            foreach (var entry in entries)
            {
                var row = new Grid
                {
                    ColumnDefinitions = new ColumnDefinitions("*,Auto"),
                    ColumnSpacing = 18
                };
                var amount = new TextBlock
                {
                    Text = Format(entry.Transaction.Amount.Amount),
                    FontWeight = FontWeight.SemiBold,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    VerticalAlignment = VerticalAlignment.Top,
                    MinWidth = 82,
                    TextAlignment = TextAlignment.Right
                };
                Grid.SetColumn(amount, 1);
                row.Children.Add(amount);
                var detail = new StackPanel
                {
                    Spacing = 2,
                    Children =
                    {
                        new TextBlock
                        {
                            Text = entry.Transaction.Description,
                            TextWrapping = TextWrapping.Wrap,
                            MaxLines = 2
                        },
                        new TextBlock
                        {
                            Text = $"{entry.AccountName} · {entry.CategoryName ?? "Uncategorized"}",
                            FontSize = 12,
                            Opacity = .65,
                            TextWrapping = TextWrapping.Wrap
                        }
                    }
                };
                row.Children.Add(detail);
                content.Children.Add(new Border
                {
                    Background = SurfaceBrush,
                    CornerRadius = new CornerRadius(5),
                    Padding = new Thickness(10),
                    Child = row
                });
            }
        }

        var flyout = new Flyout { Content = content, Placement = PlacementMode.Bottom };
        _calendarDateFlyout = flyout;
        flyout.Closed += (_, _) =>
        {
            if (ReferenceEquals(_calendarDateFlyout, flyout))
            {
                _calendarDateFlyout = null;
            }
        };
        flyout.ShowAt(anchor);
    }

    private void ShowScenarios()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowScenarios;
        _title.Text = "Scenarios";
        _content.Content = new TextBlock { Text = "Numerical scenarios will be added after the scheduled-transaction model is in place.", Opacity = .7 };
    }

    private void ShowAi()
    {
        _recordedScheduledOccurrences.Clear();
        _refreshCurrentView = ShowAi;
        _title.Text = "AI";
        _content.Content = new TextBlock
        {
            Text = "AI workspace. Connect a provider when you are ready to enable transaction normalization, category suggestions, and analysis.",
            Opacity = .7,
            TextWrapping = TextWrapping.Wrap
        };
    }

    private static StackPanel Labelled(string label, Control field) => new() { Spacing = 4, Children = { new TextBlock { Text = label }, field } };

    private static Window Dialog(string title, IEnumerable<Control> children) => new()
    {
        Title = title,
        Width = 470,
        SizeToContent = SizeToContent.Height,
        WindowStartupLocation = WindowStartupLocation.CenterOwner,
        Background = Brush.Parse("#1B2635"),
        Content = new Border
        {
            Background = Brush.Parse("#1B2635"),
            BorderBrush = Brush.Parse("#5A7494"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            BoxShadow = new BoxShadows(new BoxShadow { Blur = 28, OffsetY = 10, Color = Color.Parse("#AA000000") }),
            Child = new StackPanel { Margin = new Thickness(24), Spacing = 12, Children = { } }.Also(panel => { foreach (var child in children) panel.Children.Add(child); })
        }
    };

    private async Task Message(string title, string text)
    {
        var close = new Button { Content = "OK", HorizontalAlignment = HorizontalAlignment.Right }; var dialog = Dialog(title, new Control[] { new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap }, close }); close.Click += (_, _) => dialog.Close(); await dialog.ShowDialog(this);
    }

    private static string Format(decimal value) => value.ToString("C2", CultureInfo.CurrentCulture);

    private readonly record struct RecurringSuggestionKey(
        Guid AccountId,
        string NormalizedDescription,
        Money Amount,
        ScheduledTransactionRecurrence Recurrence)
    {
        public static RecurringSuggestionKey From(RecurringTransactionSuggestion suggestion) => new(
            suggestion.AccountId,
            suggestion.NormalizedDescription,
            suggestion.Amount,
            suggestion.Recurrence);
    }

    private readonly record struct ScheduledOccurrenceKey(Guid ScheduleId, DateOnly Date);
}

public static class CalendarSwipeNavigation
{
    /// <summary>
    /// Resolves a completed horizontal calendar drag. A left drag advances to the next month;
    /// a right drag returns to the preceding month. Exactly half a viewport returns to the
    /// current month, matching the deliberate "more than 50%" interaction threshold.
    /// </summary>
    public static int ResolveMonthOffset(double horizontalDisplacement, double viewportWidth) =>
        viewportWidth <= 0d || Math.Abs(horizontalDisplacement) <= viewportWidth / 2d
            ? 0
            : horizontalDisplacement < 0d ? 1 : -1;
}

internal sealed class CalendarSwipeState
{
    private const double DragTolerance = 4d;
    private readonly TranslateTransform _translate;
    private double _startX;
    private double _displacement;
    private bool _tracking;

    public CalendarSwipeState(TranslateTransform translate) => _translate = translate;

    public bool Dragged { get; private set; }

    public DateOnly? PressedDate { get; private set; }

    public Control? PressedDateAnchor { get; private set; }

    public void Begin(double x)
    {
        _startX = x;
        _displacement = 0d;
        _tracking = true;
        Dragged = false;
    }

    public void Move(double x, double viewportWidth)
    {
        if (!_tracking)
        {
            return;
        }

        _displacement = x - _startX;
        Dragged |= Math.Abs(_displacement) > DragTolerance;
        var limit = Math.Max(viewportWidth, 0d);
        _translate.X = limit == 0d ? _displacement : Math.Clamp(_displacement, -limit, limit);
    }

    public int End(double x, double viewportWidth)
    {
        Move(x, viewportWidth);
        _tracking = false;
        return CalendarSwipeNavigation.ResolveMonthOffset(_displacement, viewportWidth);
    }

    public void SetPressedDate(Control anchor, DateOnly date)
    {
        PressedDateAnchor = anchor;
        PressedDate = date;
    }

    public void ClearPressedDate()
    {
        PressedDate = null;
        PressedDateAnchor = null;
    }

    public void Cancel()
    {
        if (!_tracking)
        {
            return;
        }

        _tracking = false;
        _translate.X = 0d;
        ClearPressedDate();
    }
}

internal static class ControlExtensions
{
    public static T Also<T>(this T value, Action<T> action) { action(value); return value; }
}
