using FamilyFinance.Data;
using FamilyFinance.Domain;
using Microsoft.Data.Sqlite;
using System.Text;
using Xunit;

namespace FamilyFinance.Domain.Tests;

public sealed class LedgerRepositoryTests : IDisposable
{
    private readonly string _databasePath = Path.Combine(Path.GetTempPath(), $"family-finance-{Guid.NewGuid():N}.db");

    [Fact]
    public void InitializesAndRoundTripsAccountsCategoriesAndTransactions()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Primary checking", AccountType.Checking, new Money(1234.56m));
        var category = new Category(Guid.NewGuid(), "Groceries");
        var transaction = new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 30), "Neighborhood Market", new Money(-45.67m), category.Id, "weekly shop", new DateTimeOffset(2026, 7, 30, 15, 0, 0, TimeSpan.Zero));

        repository.CreateAccount(account);
        repository.CreateCategory(category);
        repository.CreateTransaction(transaction);

        Assert.Equal(new[] { account }, repository.GetAccounts());
        Assert.Equal(new[] { category }, repository.GetCategories());
        Assert.Equal(new[] { transaction }, repository.GetTransactions());
        Assert.Equal(new[] { transaction }, repository.GetTransactions(account.Id));
    }

    [Fact]
    public void EncryptsNewLocalDatabaseAtRest()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();

        var header = new byte[16];
        using (var stream = new FileStream(_databasePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            Assert.Equal(16, stream.Read(header, 0, header.Length));
        }

        Assert.NotEqual("SQLite format 3\0", Encoding.ASCII.GetString(header));
    }

    [Fact]
    public void ReplacesTheLegacyPlaintextDemoDatabase()
    {
        using (var plaintext = new SqliteConnection($"Data Source={_databasePath}"))
        {
            plaintext.Open();
            using var command = plaintext.CreateCommand();
            command.CommandText = "CREATE TABLE legacy_demo (value TEXT NOT NULL);";
            command.ExecuteNonQuery();
        }
        SqliteConnection.ClearAllPools();

        var database = new LocalDatabase(_databasePath);
        database.Initialize();

        using var encrypted = database.OpenConnection();
        using var query = encrypted.CreateCommand();
        query.CommandText = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_demo';";
        Assert.Null(query.ExecuteScalar());
    }

    [Fact]
    public void RejectsTransactionWhoseAccountDoesNotExist()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var transaction = new Transaction(Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 7, 30), "Invalid", new Money(-1m), null, null, DateTimeOffset.UtcNow);

        Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => repository.CreateTransaction(transaction));
    }

    [Fact]
    public void UpdatesExistingTransactionWithoutCreatingAnotherRecord()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var original = new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 7, 30), "Store", new Money(-10m), null, null, DateTimeOffset.UtcNow);
        repository.CreateTransaction(original);

        var edited = original.Edit(account.Id, new DateOnly(2026, 7, 31), "Store corrected", new Money(-15m), null, "corrected");
        repository.UpdateTransaction(edited);

        var stored = Assert.Single(repository.GetTransactions());
        Assert.Equal(original.Id, stored.Id);
        Assert.Equal(edited, stored);
    }

    [Fact]
    public void DeletesRegularAndBalanceAdjustmentTransactions()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var regular = new Transaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Store", new Money(-10m), null, null, DateTimeOffset.UtcNow);
        var adjustment = Transaction.CreateBalanceAdjustment(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 2), Money.Zero, new Money(25m), "Reconciled", DateTimeOffset.UtcNow);
        repository.CreateTransaction(regular);
        repository.CreateTransaction(adjustment);

        repository.DeleteTransaction(regular.Id);
        repository.DeleteTransaction(adjustment.Id);

        Assert.Empty(repository.GetTransactions());
    }

    [Fact]
    public void RejectsDeletingATransactionThatDoesNotExist()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);

        Assert.Throws<KeyNotFoundException>(() => repository.DeleteTransaction(Guid.NewGuid()));
    }

    [Fact]
    public void OrdersTransactionsDeterministicallyAndReturnsDisplayContext()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Main Account", AccountType.Checking, Money.Zero);
        var category = new Category(Guid.NewGuid(), "Groceries");
        repository.CreateAccount(account);
        repository.CreateCategory(category);
        var createdAt = new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);
        var first = new Transaction(Guid.Parse("00000000-0000-0000-0000-000000000001"), account.Id, new DateOnly(2026, 7, 30), "First", new Money(-1m), category.Id, null, createdAt);
        var second = new Transaction(Guid.Parse("00000000-0000-0000-0000-000000000002"), account.Id, new DateOnly(2026, 7, 30), "Second", new Money(-2m), null, null, createdAt);
        repository.CreateTransaction(first);
        repository.CreateTransaction(second);

        Assert.Equal(new[] { second, first }, repository.GetTransactions());
        var ledger = repository.GetLedgerTransactions();
        Assert.Collection(ledger,
            entry =>
            {
                Assert.Equal(second, entry.Transaction);
                Assert.Equal("Main Account", entry.AccountName);
                Assert.Null(entry.CategoryName);
            },
            entry =>
            {
                Assert.Equal(first, entry.Transaction);
                Assert.Equal("Main Account", entry.AccountName);
                Assert.Equal("Groceries", entry.CategoryName);
            });
    }

    [Fact]
    public void PersistsExplicitBalanceAdjustmentAsALedgerTransaction()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var adjustment = Transaction.CreateBalanceAdjustment(
            Guid.NewGuid(),
            account.Id,
            new DateOnly(2026, 8, 1),
            new Money(100m),
            new Money(112.34m),
            "Bank balance reconciliation",
            DateTimeOffset.UtcNow);

        repository.CreateTransaction(adjustment);

        var stored = Assert.Single(repository.GetTransactions());
        Assert.Equal(TransactionKind.BalanceAdjustment, stored.Kind);
        Assert.Equal("Bank balance reconciliation", stored.Notes);
        Assert.Equal(new Money(100m), stored.BalanceBeforeAdjustment);
        Assert.Equal(new Money(112.34m), stored.TargetBalance);
    }

    [Fact]
    public void PersistsSchedulesAndExcludesExplicitlySkippedOccurrences()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 15),
            "Weekly rent", new Money(-100m), null, null, ScheduledTransactionRecurrence.Weekly, DateTimeOffset.UtcNow);
        repository.CreateScheduledTransaction(schedule);
        repository.SkipScheduledOccurrence(new ScheduledTransactionSkip(
            schedule.Id, new DateOnly(2026, 8, 8), DateTimeOffset.UtcNow, "Paid early"));

        Assert.Equal(new[] { schedule }, repository.GetScheduledTransactions());
        Assert.Single(repository.GetScheduledTransactionSkips(schedule.Id));
        Assert.Equal(
            new[] { new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 15) },
            repository.GetScheduledOccurrences(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 31)).Select(x => x.Date));
    }

    [Fact]
    public void UpdatesScheduleEditableFieldsWhileRetainingItsIdentityAndCreationTime()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var checking = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        var savings = new Account(Guid.NewGuid(), "Savings", AccountType.Savings, Money.Zero);
        var category = new Category(Guid.NewGuid(), "Housing");
        repository.CreateAccount(checking);
        repository.CreateAccount(savings);
        repository.CreateCategory(category);
        var createdAt = new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);
        var original = new ScheduledTransaction(Guid.NewGuid(), checking.Id, new DateOnly(2026, 8, 1), null,
            "Rent", new Money(-1000m), null, null, ScheduledTransactionRecurrence.Monthly, createdAt);
        repository.CreateScheduledTransaction(original);

        var edited = original.Edit(savings.Id, new DateOnly(2026, 8, 8), new DateOnly(2026, 12, 8),
            "Corrected rent", new Money(-1100m), category.Id, "Updated lease", ScheduledTransactionRecurrence.Weekly);
        repository.UpdateScheduledTransaction(edited);

        var stored = Assert.Single(repository.GetScheduledTransactions());
        Assert.Equal(original.Id, stored.Id);
        Assert.Equal(original.CreatedAt, stored.CreatedAt);
        Assert.Equal(edited, stored);
    }

    [Fact]
    public void RejectsUpdatingScheduleThatDoesNotExist()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var schedule = new ScheduledTransaction(Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 8, 1), null,
            "Rent", new Money(-1000m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        Assert.Throws<KeyNotFoundException>(() => repository.UpdateScheduledTransaction(schedule));
    }

    [Fact]
    public void EnforcesScheduleAccountAndCategoryForeignKeysOnUpdate()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var schedule = new ScheduledTransaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), null,
            "Rent", new Money(-1000m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        repository.CreateScheduledTransaction(schedule);

        var invalid = schedule.Edit(Guid.NewGuid(), schedule.StartDate, schedule.EndDate, schedule.Description,
            schedule.Amount, null, schedule.Notes, schedule.Recurrence);

        Assert.Throws<SqliteException>(() => repository.UpdateScheduledTransaction(invalid));
        var invalidCategory = schedule.Edit(schedule.AccountId, schedule.StartDate, schedule.EndDate, schedule.Description,
            schedule.Amount, Guid.NewGuid(), schedule.Notes, schedule.Recurrence);
        Assert.Throws<SqliteException>(() => repository.UpdateScheduledTransaction(invalidCategory));
        Assert.Equal(schedule, Assert.Single(repository.GetScheduledTransactions()));
    }

    [Fact]
    public void CreatesCurrentTransactionAndFutureScheduleAtomically()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var transaction = new Transaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Gym", new Money(-30m), null, null, DateTimeOffset.UtcNow);
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 9, 1), null, "Gym", new Money(-30m), null, null,
            ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        repository.CreateTransactionWithSchedule(transaction, schedule);

        Assert.Equal(new[] { transaction }, repository.GetTransactions());
        Assert.Equal(new[] { schedule }, repository.GetScheduledTransactions());
    }

    [Fact]
    public void RollsBackCurrentTransactionWhenScheduleInsertFails()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var transaction = new Transaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Gym", new Money(-30m), null, null, DateTimeOffset.UtcNow);
        var scheduleWithMissingCategory = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 9, 1), null, "Gym", new Money(-30m), Guid.NewGuid(), null,
            ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        Assert.Throws<SqliteException>(() => repository.CreateTransactionWithSchedule(transaction, scheduleWithMissingCategory));

        Assert.Empty(repository.GetTransactions());
        Assert.Empty(repository.GetScheduledTransactions());
    }

    [Fact]
    public void UpdatesExistingTransactionAndCreatesFutureScheduleAtomically()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var original = new Transaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Gym", new Money(-30m), null, null, DateTimeOffset.UtcNow);
        repository.CreateTransaction(original);
        var edited = original.Edit(account.Id, new DateOnly(2026, 8, 2), "Gym membership", new Money(-35m), null, "annual increase");
        var schedule = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 9, 2), null, "Gym membership", new Money(-35m), null, "annual increase",
            ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        repository.UpdateTransactionWithSchedule(edited, schedule);

        Assert.Equal(new[] { edited }, repository.GetTransactions());
        Assert.Equal(new[] { schedule }, repository.GetScheduledTransactions());
    }

    [Fact]
    public void RollsBackExistingTransactionUpdateWhenScheduleInsertFails()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var original = new Transaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Gym", new Money(-30m), null, null, DateTimeOffset.UtcNow);
        repository.CreateTransaction(original);
        var edited = original.Edit(account.Id, new DateOnly(2026, 8, 2), "Gym membership", new Money(-35m), null, "annual increase");
        var scheduleWithMissingCategory = new ScheduledTransaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 9, 2), null, "Gym membership", new Money(-35m), Guid.NewGuid(), "annual increase",
            ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        Assert.Throws<SqliteException>(() => repository.UpdateTransactionWithSchedule(edited, scheduleWithMissingCategory));

        Assert.Equal(new[] { original }, repository.GetTransactions());
        Assert.Empty(repository.GetScheduledTransactions());
    }

    [Fact]
    public void RejectsScheduleForADifferentAccountBeforeUpdatingTransaction()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        var otherAccount = new Account(Guid.NewGuid(), "Savings", AccountType.Savings, Money.Zero);
        repository.CreateAccount(account);
        repository.CreateAccount(otherAccount);
        var original = new Transaction(
            Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), "Gym", new Money(-30m), null, null, DateTimeOffset.UtcNow);
        repository.CreateTransaction(original);
        var edited = original.Edit(account.Id, new DateOnly(2026, 8, 2), "Gym membership", new Money(-35m), null, null);
        var mismatchedSchedule = new ScheduledTransaction(
            Guid.NewGuid(), otherAccount.Id, new DateOnly(2026, 9, 2), null, "Gym membership", new Money(-35m), null, null,
            ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);

        Assert.Throws<ArgumentException>(() => repository.UpdateTransactionWithSchedule(edited, mismatchedSchedule));

        Assert.Equal(new[] { original }, repository.GetTransactions());
        Assert.Empty(repository.GetScheduledTransactions());
    }

    [Fact]
    public void PostsOneScheduledOccurrenceAsAnAuditableRegularLedgerTransaction()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        var category = new Category(Guid.NewGuid(), "Housing");
        repository.CreateAccount(account);
        repository.CreateCategory(category);
        var schedule = new ScheduledTransaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), null,
            "Rent", new Money(-1250m), category.Id, "August rent", ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        repository.CreateScheduledTransaction(schedule);

        var postedAt = new DateTimeOffset(2026, 8, 1, 14, 0, 0, TimeSpan.Zero);
        var entry = repository.PostScheduledOccurrence(schedule.Id, new DateOnly(2026, 8, 1), postedAt);

        Assert.Equal(TransactionKind.Regular, entry.Kind);
        Assert.Equal(account.Id, entry.AccountId);
        Assert.Equal(new DateOnly(2026, 8, 1), entry.Date);
        Assert.Equal("Rent", entry.Description);
        Assert.Equal(new Money(-1250m), entry.Amount);
        Assert.Equal(category.Id, entry.CategoryId);
        Assert.Equal("August rent", entry.Notes);
        Assert.Equal(new[] { entry }, repository.GetTransactions());
        Assert.Equal(new[] { new ScheduledTransactionPosting(schedule.Id, entry.Date, entry.Id, postedAt) }, repository.GetScheduledTransactionPostings(schedule.Id));
        var ledgerEntry = Assert.Single(repository.GetLedgerTransactions());
        Assert.Equal(schedule.Id, ledgerEntry.ScheduledPosting?.ScheduledTransactionId);
        Assert.Equal(entry.Date, ledgerEntry.ScheduledPosting?.OccurrenceDate);
        Assert.Equal(postedAt, ledgerEntry.ScheduledPosting?.PostedAt);
        Assert.Equal(new[] { new DateOnly(2026, 9, 1) }, repository.GetScheduledOccurrences(new DateOnly(2026, 8, 1), new DateOnly(2026, 9, 30)).Select(item => item.Date));
    }

    [Fact]
    public void DeletingPostedScheduledTransactionRestoresThePendingOccurrence()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var occurrenceDate = new DateOnly(2026, 8, 1);
        var schedule = new ScheduledTransaction(Guid.NewGuid(), account.Id, occurrenceDate, null,
            "Rent", new Money(-1250m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        repository.CreateScheduledTransaction(schedule);
        var postedEntry = repository.PostScheduledOccurrence(schedule.Id, occurrenceDate, DateTimeOffset.UtcNow);

        repository.DeleteTransaction(postedEntry.Id);

        Assert.Empty(repository.GetTransactions());
        Assert.Empty(repository.GetScheduledTransactionPostings(schedule.Id));
        var pending = Assert.Single(repository.GetScheduledOccurrences(occurrenceDate, occurrenceDate));
        Assert.Equal(schedule.Id, pending.Schedule.Id);
        Assert.Equal(occurrenceDate, pending.Date);
    }

    [Fact]
    public void RejectsDuplicateOrSkippedScheduledOccurrencePostingWithoutChangingTheLedger()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var schedule = new ScheduledTransaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), null,
            "Utilities", new Money(-50m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        repository.CreateScheduledTransaction(schedule);
        var occurrenceDate = new DateOnly(2026, 8, 1);

        repository.PostScheduledOccurrence(schedule.Id, occurrenceDate, DateTimeOffset.UtcNow);
        Assert.Throws<InvalidOperationException>(() => repository.PostScheduledOccurrence(schedule.Id, occurrenceDate, DateTimeOffset.UtcNow));
        Assert.Throws<InvalidOperationException>(() => repository.SkipScheduledOccurrence(new ScheduledTransactionSkip(schedule.Id, occurrenceDate, DateTimeOffset.UtcNow, null)));

        var skippedDate = new DateOnly(2026, 9, 1);
        repository.SkipScheduledOccurrence(new ScheduledTransactionSkip(schedule.Id, skippedDate, DateTimeOffset.UtcNow, "Not due"));
        Assert.Throws<InvalidOperationException>(() => repository.PostScheduledOccurrence(schedule.Id, skippedDate, DateTimeOffset.UtcNow));
        Assert.Single(repository.GetTransactions());
        Assert.Single(repository.GetScheduledTransactionPostings(schedule.Id));
    }

    [Fact]
    public void RollsBackScheduledOccurrencePostingWhenAuditLinkCannotBeWritten()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        var repository = new LedgerRepository(database);
        var account = new Account(Guid.NewGuid(), "Checking", AccountType.Checking, Money.Zero);
        repository.CreateAccount(account);
        var schedule = new ScheduledTransaction(Guid.NewGuid(), account.Id, new DateOnly(2026, 8, 1), null,
            "Insurance", new Money(-99m), null, null, ScheduledTransactionRecurrence.Monthly, DateTimeOffset.UtcNow);
        repository.CreateScheduledTransaction(schedule);
        using (var connection = database.OpenConnection())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "CREATE TRIGGER reject_schedule_posting BEFORE INSERT ON scheduled_transaction_postings BEGIN SELECT RAISE(ABORT, 'test rejection'); END;";
            command.ExecuteNonQuery();
        }

        Assert.Throws<SqliteException>(() => repository.PostScheduledOccurrence(schedule.Id, new DateOnly(2026, 8, 1), DateTimeOffset.UtcNow));

        Assert.Empty(repository.GetTransactions());
        Assert.Empty(repository.GetScheduledTransactionPostings(schedule.Id));
        Assert.Single(repository.GetScheduledOccurrences(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 1)));
    }

    [Fact]
    public void RecoversAnInterruptedColumnMigrationWithoutDuplicatingTheColumn()
    {
        var database = new LocalDatabase(_databasePath);
        using (var connection = database.OpenConnection())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                CREATE TABLE schema_migrations (version INTEGER NOT NULL PRIMARY KEY);
                INSERT INTO schema_migrations(version) VALUES (1);
                CREATE TABLE accounts (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, type INTEGER NOT NULL, opening_balance TEXT NOT NULL);
                CREATE TABLE categories (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
                CREATE TABLE transactions (
                    id TEXT NOT NULL PRIMARY KEY, account_id TEXT NOT NULL, transaction_date TEXT NOT NULL,
                    description TEXT NOT NULL, amount TEXT NOT NULL, category_id TEXT NULL, notes TEXT NULL,
                    created_at TEXT NOT NULL, transaction_kind INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(account_id) REFERENCES accounts(id), FOREIGN KEY(category_id) REFERENCES categories(id));
                """;
            command.ExecuteNonQuery();
        }

        database.Initialize();
        database.Initialize();

        using var verificationConnection = database.OpenConnection();
        using var verificationCommand = verificationConnection.CreateCommand();
        verificationCommand.CommandText = "SELECT COUNT(*) FROM schema_migrations;";
        Assert.Equal(6L, verificationCommand.ExecuteScalar());
    }

    [Fact]
    public void DoesNotRecordAMigrationWhenItsSchemaChangesFail()
    {
        var database = new LocalDatabase(_databasePath);
        using (var connection = database.OpenConnection())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                CREATE TABLE schema_migrations (version INTEGER NOT NULL PRIMARY KEY);
                INSERT INTO schema_migrations(version) VALUES (1), (2);
                CREATE TABLE scheduled_transactions (id TEXT NOT NULL PRIMARY KEY);
                """;
            command.ExecuteNonQuery();
        }

        Assert.Throws<SqliteException>(() => database.Initialize());

        using var verificationConnection = database.OpenConnection();
        using var verificationCommand = verificationConnection.CreateCommand();
        verificationCommand.CommandText = "SELECT COUNT(*) FROM schema_migrations WHERE version = 3;";
        Assert.Equal(0L, verificationCommand.ExecuteScalar());
    }

    [Fact]
    public void RejectsAnUnsupportedAccountTypeStoredInTheDatabase()
    {
        var database = new LocalDatabase(_databasePath);
        database.Initialize();
        using (var connection = database.OpenConnection())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "PRAGMA ignore_check_constraints = ON;";
            command.ExecuteNonQuery();
            command.CommandText = "INSERT INTO accounts (id, name, type, opening_balance) VALUES ($id, 'Corrupted', 999, '0');";
            command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("D"));
            command.ExecuteNonQuery();
        }

        var repository = new LedgerRepository(database);
        Assert.Throws<InvalidDataException>(() => repository.GetAccounts());
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (File.Exists(_databasePath))
        {
            File.Delete(_databasePath);
        }
        var keyPath = _databasePath + ".key.dpapi";
        if (File.Exists(keyPath))
        {
            File.Delete(keyPath);
        }
    }
}
