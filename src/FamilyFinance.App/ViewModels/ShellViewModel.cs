using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;

namespace FamilyFinance.App.ViewModels;

public sealed class ShellViewModel : INotifyPropertyChanged
{
    private ShellView _currentView = new DashboardView();

    public ShellView CurrentView
    {
        get => _currentView;
        private set
        {
            if (_currentView == value)
            {
                return;
            }

            _currentView = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(CurrentViewTitle));
        }
    }

    public string CurrentViewTitle => CurrentView.Title;

    public ICommand ShowDashboardCommand { get; }
    public ICommand ShowCalendarCommand { get; }
    public ICommand ShowLedgerCommand { get; }
    public ICommand ShowAccountsCommand { get; }
    public ICommand ShowScenariosCommand { get; }

    public ShellViewModel()
    {
        ShowDashboardCommand = new DelegateCommand(() => CurrentView = new DashboardView());
        ShowCalendarCommand = new DelegateCommand(() => CurrentView = new PlaceholderView("Calendar", "Calendar totals will be available when the ledger is connected."));
        ShowLedgerCommand = new DelegateCommand(() => CurrentView = new PlaceholderView("Ledger", "Manual transaction entry is the next ledger milestone."));
        ShowAccountsCommand = new DelegateCommand(() => CurrentView = new PlaceholderView("Accounts", "Account setup is the next ledger milestone."));
        ShowScenariosCommand = new DelegateCommand(() => CurrentView = new PlaceholderView("Scenarios", "Numerical scenarios will follow the local ledger foundation."));
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}

public abstract record ShellView(string Title);

public sealed record DashboardView() : ShellView("Dashboard");

public sealed record PlaceholderView(string Title, string Message) : ShellView(Title);

internal sealed class DelegateCommand(Action execute) : ICommand
{
    public event EventHandler? CanExecuteChanged
    {
        add { }
        remove { }
    }

    public bool CanExecute(object? parameter) => true;

    public void Execute(object? parameter) => execute();
}
