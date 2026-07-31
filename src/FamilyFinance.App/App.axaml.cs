using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Markup.Xaml;

namespace FamilyFinance.App;

public sealed class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            try
            {
                desktop.MainWindow = new MainWindow();
            }
            catch (Exception exception)
            {
                desktop.MainWindow = CreateStartupRecoveryWindow(exception);
            }
        }

        base.OnFrameworkInitializationCompleted();
    }

    private static Window CreateStartupRecoveryWindow(Exception exception)
    {
        var close = new Button { Content = "Close", HorizontalAlignment = HorizontalAlignment.Right };
        var window = new Window
        {
            Title = "FamilyFinance couldn't start",
            Width = 520,
            SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Content = new StackPanel
            {
                Margin = new Thickness(28),
                Spacing = 14,
                Children =
                {
                    new TextBlock
                    {
                        Text = "FamilyFinance couldn't open its local data store. Your data has not been changed.",
                        FontSize = 18,
                        FontWeight = FontWeight.SemiBold,
                        TextWrapping = TextWrapping.Wrap
                    },
                    new TextBlock
                    {
                        Text = "Close the app and try again. If this continues, make a copy of the FamilyFinance folder in Local AppData before seeking support.",
                        TextWrapping = TextWrapping.Wrap
                    },
                    new TextBlock
                    {
                        Text = $"Startup detail: {exception.GetType().Name}: {exception.Message}",
                        Opacity = .7,
                        TextWrapping = TextWrapping.Wrap
                    },
                    close
                }
            }
        };
        close.Click += (_, _) => window.Close();
        return window;
    }
}
