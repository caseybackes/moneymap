using System.Globalization;
using FamilyFinance.Domain;
using Microsoft.Data.Sqlite;

namespace FamilyFinance.Data;

public sealed class LedgerRepository(LocalDatabase database)
{
    public void CreateAccount(Account account)
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO accounts (id, name, type, opening_balance) VALUES ($id, $name, $type, $openingBalance);";
        command.Parameters.AddWithValue("$id", account.Id.ToString("D"));
        command.Parameters.AddWithValue("$name", account.Name);
        command.Parameters.AddWithValue("$type", (int)account.Type);
        command.Parameters.AddWithValue("$openingBalance", FormatMoney(account.OpeningBalance));
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<Account> GetAccounts()
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, name, type, opening_balance FROM accounts ORDER BY name COLLATE NOCASE;";
        using var reader = command.ExecuteReader();
        var accounts = new List<Account>();
        while (reader.Read())
        {
            accounts.Add(new Account(
                Guid.Parse(reader.GetString(0)),
                reader.GetString(1),
                ReadAccountType(reader.GetInt32(2)),
                ParseMoney(reader.GetString(3))));
        }

        return accounts;
    }

    public void CreateCategory(Category category)
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO categories (id, name) VALUES ($id, $name);";
        command.Parameters.AddWithValue("$id", category.Id.ToString("D"));
        command.Parameters.AddWithValue("$name", category.Name);
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<Category> GetCategories()
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, name FROM categories ORDER BY name COLLATE NOCASE;";
        using var reader = command.ExecuteReader();
        var categories = new List<Category>();
        while (reader.Read())
        {
            categories.Add(new Category(Guid.Parse(reader.GetString(0)), reader.GetString(1)));
        }

        return categories;
    }

    public void CreateTransaction(Transaction transaction)
    {
        ArgumentNullException.ThrowIfNull(transaction);

        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        ConfigureTransactionInsert(command, transaction);
        command.ExecuteNonQuery();
    }

    /// <summary>Imports an external transaction once. The provider transaction id is the durable deduplication key.</summary>
    public bool TryImportTransaction(string provider, string providerTransactionId, string connectionId, Transaction transaction)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(provider);
        ArgumentException.ThrowIfNullOrWhiteSpace(providerTransactionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionId);
        ArgumentNullException.ThrowIfNull(transaction);

        using var connection = database.OpenConnection();
        using var databaseTransaction = connection.BeginTransaction();
        using (var exists = connection.CreateCommand())
        {
            exists.Transaction = databaseTransaction;
            exists.CommandText = "SELECT 1 FROM imported_transactions WHERE provider = $provider AND provider_transaction_id = $providerTransactionId;";
            exists.Parameters.AddWithValue("$provider", provider);
            exists.Parameters.AddWithValue("$providerTransactionId", providerTransactionId);
            if (exists.ExecuteScalar() is not null)
            {
                databaseTransaction.Commit();
                return false;
            }
        }

        using (var insert = connection.CreateCommand())
        {
            insert.Transaction = databaseTransaction;
            ConfigureTransactionInsert(insert, transaction);
            insert.ExecuteNonQuery();
        }
        using (var marker = connection.CreateCommand())
        {
            marker.Transaction = databaseTransaction;
            marker.CommandText = "INSERT INTO imported_transactions(provider, provider_transaction_id, connection_id, transaction_id, imported_at) VALUES ($provider, $providerTransactionId, $connectionId, $transactionId, $importedAt);";
            marker.Parameters.AddWithValue("$provider", provider);
            marker.Parameters.AddWithValue("$providerTransactionId", providerTransactionId);
            marker.Parameters.AddWithValue("$connectionId", connectionId);
            marker.Parameters.AddWithValue("$transactionId", transaction.Id.ToString("D"));
            marker.Parameters.AddWithValue("$importedAt", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            marker.ExecuteNonQuery();
        }
        databaseTransaction.Commit();
        return true;
    }

    /// <summary>
    /// Saves a current ledger entry and the future schedule created from it as one unit of work.
    /// A failure in either insert leaves neither record persisted.
    /// </summary>
    public void CreateTransactionWithSchedule(Transaction transaction, ScheduledTransaction scheduledTransaction)
    {
        ArgumentNullException.ThrowIfNull(transaction);
        ArgumentNullException.ThrowIfNull(scheduledTransaction);
        if (transaction.AccountId != scheduledTransaction.AccountId)
        {
            throw new ArgumentException("A recurring schedule must use the transaction's account.", nameof(scheduledTransaction));
        }

        using var connection = database.OpenConnection();
        using var databaseTransaction = connection.BeginTransaction();
        using var transactionCommand = connection.CreateCommand();
        transactionCommand.Transaction = databaseTransaction;
        ConfigureTransactionInsert(transactionCommand, transaction);
        transactionCommand.ExecuteNonQuery();

        using var scheduleCommand = connection.CreateCommand();
        scheduleCommand.Transaction = databaseTransaction;
        ConfigureScheduledTransactionInsert(scheduleCommand, scheduledTransaction);
        scheduleCommand.ExecuteNonQuery();

        databaseTransaction.Commit();
    }

    public void UpdateTransaction(Transaction transaction)
    {
        ArgumentNullException.ThrowIfNull(transaction);

        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        ConfigureTransactionUpdate(command, transaction);
        if (command.ExecuteNonQuery() != 1)
        {
            throw new KeyNotFoundException($"Transaction '{transaction.Id:D}' does not exist.");
        }
    }

    /// <summary>
    /// Removes a ledger entry. If the entry was posted from a scheduled occurrence,
    /// its posting record is removed in the same database transaction so the
    /// occurrence is available to be recorded again.
    /// </summary>
    public void DeleteTransaction(Guid transactionId)
    {
        using var connection = database.OpenConnection();
        using var databaseTransaction = connection.BeginTransaction();

        using (var postingCommand = connection.CreateCommand())
        {
            postingCommand.Transaction = databaseTransaction;
            postingCommand.CommandText = "DELETE FROM scheduled_transaction_postings WHERE transaction_id = $transactionId;";
            postingCommand.Parameters.AddWithValue("$transactionId", transactionId.ToString("D"));
            postingCommand.ExecuteNonQuery();
        }

        using (var transactionCommand = connection.CreateCommand())
        {
            transactionCommand.Transaction = databaseTransaction;
            transactionCommand.CommandText = "DELETE FROM transactions WHERE id = $id;";
            transactionCommand.Parameters.AddWithValue("$id", transactionId.ToString("D"));
            if (transactionCommand.ExecuteNonQuery() != 1)
            {
                throw new KeyNotFoundException($"Transaction '{transactionId:D}' does not exist.");
            }
        }

        databaseTransaction.Commit();
    }

    /// <summary>
    /// Updates an existing regular ledger entry and creates its future recurring schedule as one unit of work.
    /// A failure in either operation leaves the existing transaction and schedules unchanged.
    /// </summary>
    public void UpdateTransactionWithSchedule(Transaction transaction, ScheduledTransaction scheduledTransaction)
    {
        ArgumentNullException.ThrowIfNull(transaction);
        ArgumentNullException.ThrowIfNull(scheduledTransaction);
        if (transaction.Kind != TransactionKind.Regular)
        {
            throw new ArgumentException("Only regular transactions can create recurring schedules.", nameof(transaction));
        }

        if (transaction.AccountId != scheduledTransaction.AccountId)
        {
            throw new ArgumentException("A recurring schedule must use the transaction's account.", nameof(scheduledTransaction));
        }

        using var connection = database.OpenConnection();
        using var databaseTransaction = connection.BeginTransaction();
        using var transactionCommand = connection.CreateCommand();
        transactionCommand.Transaction = databaseTransaction;
        ConfigureTransactionUpdate(transactionCommand, transaction);
        if (transactionCommand.ExecuteNonQuery() != 1)
        {
            throw new KeyNotFoundException($"Transaction '{transaction.Id:D}' does not exist.");
        }

        using var scheduleCommand = connection.CreateCommand();
        scheduleCommand.Transaction = databaseTransaction;
        ConfigureScheduledTransactionInsert(scheduleCommand, scheduledTransaction);
        scheduleCommand.ExecuteNonQuery();

        databaseTransaction.Commit();
    }

    public IReadOnlyList<Transaction> GetTransactions(Guid? accountId = null)
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, account_id, transaction_date, description, amount, category_id, notes, created_at, transaction_kind, balance_before_adjustment, target_balance FROM transactions" +
            (accountId is null ? string.Empty : " WHERE account_id = $accountId") +
            " ORDER BY transaction_date DESC, created_at DESC, id DESC;";
        if (accountId is not null)
        {
            command.Parameters.AddWithValue("$accountId", accountId.Value.ToString("D"));
        }

        using var reader = command.ExecuteReader();
        var transactions = new List<Transaction>();
        while (reader.Read())
        {
            transactions.Add(new Transaction(
                Guid.Parse(reader.GetString(0)),
                Guid.Parse(reader.GetString(1)),
                DateOnly.ParseExact(reader.GetString(2), "yyyy-MM-dd", CultureInfo.InvariantCulture),
                reader.GetString(3),
                ParseMoney(reader.GetString(4)),
                reader.IsDBNull(5) ? null : Guid.Parse(reader.GetString(5)),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                DateTimeOffset.Parse(reader.GetString(7), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
                (TransactionKind)reader.GetInt32(8),
                reader.IsDBNull(9) ? null : ParseMoney(reader.GetString(9)),
                reader.IsDBNull(10) ? null : ParseMoney(reader.GetString(10))));
        }

        return transactions;
    }

    public IReadOnlyList<LedgerTransaction> GetLedgerTransactions(Guid? accountId = null)
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT t.id, t.account_id, t.transaction_date, t.description, t.amount, t.category_id, t.notes, t.created_at, t.transaction_kind, t.balance_before_adjustment, t.target_balance,
                   a.name, c.name,
                   p.scheduled_transaction_id, p.occurrence_date, p.posted_at
            FROM transactions t
            INNER JOIN accounts a ON a.id = t.account_id
            LEFT JOIN categories c ON c.id = t.category_id
            LEFT JOIN scheduled_transaction_postings p ON p.transaction_id = t.id
            """ + (accountId is null ? string.Empty : " WHERE t.account_id = $accountId") +
            " ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC;";
        if (accountId is not null)
        {
            command.Parameters.AddWithValue("$accountId", accountId.Value.ToString("D"));
        }

        using var reader = command.ExecuteReader();
        var transactions = new List<LedgerTransaction>();
        while (reader.Read())
        {
            var transaction = ReadTransaction(reader);
            var scheduledPosting = reader.IsDBNull(13)
                ? null
                : new ScheduledTransactionPosting(
                    Guid.Parse(reader.GetString(13)),
                    DateOnly.ParseExact(reader.GetString(14), "yyyy-MM-dd", CultureInfo.InvariantCulture),
                    transaction.Id,
                    DateTimeOffset.Parse(reader.GetString(15), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind));
            transactions.Add(new LedgerTransaction(
                transaction,
                reader.GetString(11),
                reader.IsDBNull(12) ? null : reader.GetString(12),
                scheduledPosting));
        }

        return transactions;
    }

    private static void AddTransactionParameters(SqliteCommand command, Transaction transaction)
    {
        command.Parameters.AddWithValue("$id", transaction.Id.ToString("D"));
        command.Parameters.AddWithValue("$accountId", transaction.AccountId.ToString("D"));
        command.Parameters.AddWithValue("$date", transaction.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$description", transaction.Description);
        command.Parameters.AddWithValue("$amount", FormatMoney(transaction.Amount));
        command.Parameters.AddWithValue("$categoryId", transaction.CategoryId?.ToString("D") ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$notes", transaction.Notes ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$createdAt", transaction.CreatedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$kind", (int)transaction.Kind);
        command.Parameters.AddWithValue("$balanceBeforeAdjustment", transaction.BalanceBeforeAdjustment is null ? DBNull.Value : FormatMoney(transaction.BalanceBeforeAdjustment.Value));
        command.Parameters.AddWithValue("$targetBalance", transaction.TargetBalance is null ? DBNull.Value : FormatMoney(transaction.TargetBalance.Value));
    }

    private static void ConfigureTransactionInsert(SqliteCommand command, Transaction transaction)
    {
        command.CommandText = """
            INSERT INTO transactions (id, account_id, transaction_date, description, amount, category_id, notes, created_at, transaction_kind, balance_before_adjustment, target_balance)
            VALUES ($id, $accountId, $date, $description, $amount, $categoryId, $notes, $createdAt, $kind, $balanceBeforeAdjustment, $targetBalance);
            """;
        AddTransactionParameters(command, transaction);
    }

    private static void ConfigureTransactionUpdate(SqliteCommand command, Transaction transaction)
    {
        command.CommandText = """
            UPDATE transactions
            SET account_id = $accountId, transaction_date = $date, description = $description,
                amount = $amount, category_id = $categoryId, notes = $notes, transaction_kind = $kind,
                balance_before_adjustment = $balanceBeforeAdjustment, target_balance = $targetBalance
            WHERE id = $id;
            """;
        AddTransactionParameters(command, transaction);
    }

    private static Transaction ReadTransaction(SqliteDataReader reader) => new(
        Guid.Parse(reader.GetString(0)),
        Guid.Parse(reader.GetString(1)),
        DateOnly.ParseExact(reader.GetString(2), "yyyy-MM-dd", CultureInfo.InvariantCulture),
        reader.GetString(3),
        ParseMoney(reader.GetString(4)),
        reader.IsDBNull(5) ? null : Guid.Parse(reader.GetString(5)),
        reader.IsDBNull(6) ? null : reader.GetString(6),
        DateTimeOffset.Parse(reader.GetString(7), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
        (TransactionKind)reader.GetInt32(8),
        reader.IsDBNull(9) ? null : ParseMoney(reader.GetString(9)),
        reader.IsDBNull(10) ? null : ParseMoney(reader.GetString(10)));

    private static AccountType ReadAccountType(int value)
    {
        var accountType = (AccountType)value;
        if (!Enum.IsDefined(accountType))
        {
            throw new InvalidDataException($"Account data contains unsupported account type value '{value}'.");
        }

        return accountType;
    }

    public void CreateScheduledTransaction(ScheduledTransaction scheduledTransaction)
    {
        ArgumentNullException.ThrowIfNull(scheduledTransaction);

        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        ConfigureScheduledTransactionInsert(command, scheduledTransaction);
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<ScheduledTransaction> GetScheduledTransactions()
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, account_id, start_date, end_date, description, amount, category_id, notes, recurrence, created_at
            FROM scheduled_transactions
            ORDER BY start_date, created_at, id;
            """;
        using var reader = command.ExecuteReader();
        var schedules = new List<ScheduledTransaction>();
        while (reader.Read())
        {
            schedules.Add(ReadScheduledTransaction(reader));
        }

        return schedules;
    }

    /// <summary>
    /// Replaces a schedule's editable plan fields while retaining its durable identity, creation timestamp,
    /// and existing occurrence skip/posting audit records.
    /// </summary>
    public void UpdateScheduledTransaction(ScheduledTransaction scheduledTransaction)
    {
        ArgumentNullException.ThrowIfNull(scheduledTransaction);

        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE scheduled_transactions
            SET account_id = $accountId,
                start_date = $startDate,
                end_date = $endDate,
                description = $description,
                amount = $amount,
                category_id = $categoryId,
                notes = $notes,
                recurrence = $recurrence
            WHERE id = $id;
            """;
        AddScheduledTransactionParameters(command, scheduledTransaction, includeCreatedAt: false);
        if (command.ExecuteNonQuery() != 1)
        {
            throw new KeyNotFoundException($"Scheduled transaction '{scheduledTransaction.Id:D}' does not exist.");
        }
    }

    public void SkipScheduledOccurrence(ScheduledTransactionSkip skip)
    {
        ArgumentNullException.ThrowIfNull(skip);

        var schedule = GetScheduledTransactions().SingleOrDefault(item => item.Id == skip.ScheduledTransactionId)
            ?? throw new KeyNotFoundException($"Scheduled transaction '{skip.ScheduledTransactionId:D}' does not exist.");
        if (!schedule.GetOccurrenceDates(skip.OccurrenceDate, skip.OccurrenceDate).Contains(skip.OccurrenceDate))
        {
            throw new ArgumentException("Only an actual scheduled occurrence can be skipped.", nameof(skip));
        }

        using var connection = database.OpenConnection();
        if (HasScheduledPosting(connection, null, skip.ScheduledTransactionId, skip.OccurrenceDate))
        {
            throw new InvalidOperationException("A posted occurrence cannot be skipped.");
        }
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO scheduled_transaction_skips (scheduled_transaction_id, occurrence_date, skipped_at, reason)
            VALUES ($scheduleId, $occurrenceDate, $skippedAt, $reason);
            """;
        command.Parameters.AddWithValue("$scheduleId", skip.ScheduledTransactionId.ToString("D"));
        command.Parameters.AddWithValue("$occurrenceDate", skip.OccurrenceDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$skippedAt", skip.SkippedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$reason", skip.Reason ?? (object)DBNull.Value);
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<ScheduledTransactionSkip> GetScheduledTransactionSkips(Guid scheduledTransactionId)
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT scheduled_transaction_id, occurrence_date, skipped_at, reason
            FROM scheduled_transaction_skips
            WHERE scheduled_transaction_id = $scheduleId
            ORDER BY occurrence_date;
            """;
        command.Parameters.AddWithValue("$scheduleId", scheduledTransactionId.ToString("D"));
        using var reader = command.ExecuteReader();
        var skips = new List<ScheduledTransactionSkip>();
        while (reader.Read())
        {
            skips.Add(new ScheduledTransactionSkip(
                Guid.Parse(reader.GetString(0)),
                DateOnly.ParseExact(reader.GetString(1), "yyyy-MM-dd", CultureInfo.InvariantCulture),
                DateTimeOffset.Parse(reader.GetString(2), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
                reader.IsDBNull(3) ? null : reader.GetString(3)));
        }

        return skips;
    }

    public IReadOnlyList<ScheduledTransactionOccurrence> GetScheduledOccurrences(DateOnly from, DateOnly through)
    {
        var occurrences = new List<ScheduledTransactionOccurrence>();
        foreach (var schedule in GetScheduledTransactions())
        {
            var skippedDates = GetScheduledTransactionSkips(schedule.Id)
                .Select(skip => skip.OccurrenceDate)
                .ToHashSet();
            var postedDates = GetScheduledTransactionPostings(schedule.Id)
                .Select(posting => posting.OccurrenceDate)
                .ToHashSet();
            occurrences.AddRange(schedule.GetOccurrenceDates(from, through)
                .Where(date => !skippedDates.Contains(date) && !postedDates.Contains(date))
                .Select(date => new ScheduledTransactionOccurrence(schedule, date)));
        }

        return occurrences.OrderBy(occurrence => occurrence.Date).ThenBy(occurrence => occurrence.Schedule.Id).ToArray();
    }

    /// <summary>
    /// Converts exactly one unresolved schedule occurrence into a regular ledger transaction and records
    /// the durable schedule/date-to-transaction audit link in the same database transaction.
    /// </summary>
    public Transaction PostScheduledOccurrence(Guid scheduledTransactionId, DateOnly occurrenceDate, DateTimeOffset postedAt)
    {
        if (scheduledTransactionId == Guid.Empty) throw new ArgumentException("A schedule identifier is required.", nameof(scheduledTransactionId));
        if (occurrenceDate == default) throw new ArgumentException("An occurrence date is required.", nameof(occurrenceDate));

        using var connection = database.OpenConnection();
        using var databaseTransaction = connection.BeginTransaction();
        var schedule = GetScheduledTransaction(connection, databaseTransaction, scheduledTransactionId)
            ?? throw new KeyNotFoundException($"Scheduled transaction '{scheduledTransactionId:D}' does not exist.");
        if (!schedule.GetOccurrenceDates(occurrenceDate, occurrenceDate).Contains(occurrenceDate))
        {
            throw new ArgumentException("Only an actual scheduled occurrence can be posted.", nameof(occurrenceDate));
        }
        if (HasScheduledSkip(connection, databaseTransaction, scheduledTransactionId, occurrenceDate))
        {
            throw new InvalidOperationException("A skipped occurrence cannot be posted.");
        }
        if (HasScheduledPosting(connection, databaseTransaction, scheduledTransactionId, occurrenceDate))
        {
            throw new InvalidOperationException("This occurrence has already been posted.");
        }

        var entry = new Transaction(Guid.NewGuid(), schedule.AccountId, occurrenceDate, schedule.Description,
            schedule.Amount, schedule.CategoryId, schedule.Notes, postedAt);
        using (var transactionCommand = connection.CreateCommand())
        {
            transactionCommand.Transaction = databaseTransaction;
            ConfigureTransactionInsert(transactionCommand, entry);
            transactionCommand.ExecuteNonQuery();
        }
        using (var postingCommand = connection.CreateCommand())
        {
            postingCommand.Transaction = databaseTransaction;
            postingCommand.CommandText = """
                INSERT INTO scheduled_transaction_postings (scheduled_transaction_id, occurrence_date, transaction_id, posted_at)
                VALUES ($scheduleId, $occurrenceDate, $transactionId, $postedAt);
                """;
            postingCommand.Parameters.AddWithValue("$scheduleId", scheduledTransactionId.ToString("D"));
            postingCommand.Parameters.AddWithValue("$occurrenceDate", occurrenceDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
            postingCommand.Parameters.AddWithValue("$transactionId", entry.Id.ToString("D"));
            postingCommand.Parameters.AddWithValue("$postedAt", postedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            postingCommand.ExecuteNonQuery();
        }
        databaseTransaction.Commit();
        return entry;
    }

    public IReadOnlyList<ScheduledTransactionPosting> GetScheduledTransactionPostings(Guid scheduledTransactionId)
    {
        using var connection = database.OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT scheduled_transaction_id, occurrence_date, transaction_id, posted_at FROM scheduled_transaction_postings WHERE scheduled_transaction_id = $scheduleId ORDER BY occurrence_date;";
        command.Parameters.AddWithValue("$scheduleId", scheduledTransactionId.ToString("D"));
        using var reader = command.ExecuteReader();
        var postings = new List<ScheduledTransactionPosting>();
        while (reader.Read())
        {
            postings.Add(new ScheduledTransactionPosting(Guid.Parse(reader.GetString(0)), DateOnly.ParseExact(reader.GetString(1), "yyyy-MM-dd", CultureInfo.InvariantCulture), Guid.Parse(reader.GetString(2)), DateTimeOffset.Parse(reader.GetString(3), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)));
        }
        return postings;
    }

    private static bool HasScheduledSkip(SqliteConnection connection, SqliteTransaction? transaction, Guid scheduleId, DateOnly occurrenceDate) =>
        HasOccurrenceResolution(connection, transaction, "scheduled_transaction_skips", scheduleId, occurrenceDate);

    private static bool HasScheduledPosting(SqliteConnection connection, SqliteTransaction? transaction, Guid scheduleId, DateOnly occurrenceDate) =>
        HasOccurrenceResolution(connection, transaction, "scheduled_transaction_postings", scheduleId, occurrenceDate);

    private static bool HasOccurrenceResolution(SqliteConnection connection, SqliteTransaction? transaction, string table, Guid scheduleId, DateOnly occurrenceDate)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"SELECT 1 FROM {table} WHERE scheduled_transaction_id = $scheduleId AND occurrence_date = $occurrenceDate;";
        command.Parameters.AddWithValue("$scheduleId", scheduleId.ToString("D"));
        command.Parameters.AddWithValue("$occurrenceDate", occurrenceDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        return command.ExecuteScalar() is not null;
    }

    private static ScheduledTransaction? GetScheduledTransaction(SqliteConnection connection, SqliteTransaction transaction, Guid scheduleId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT id, account_id, start_date, end_date, description, amount, category_id, notes, recurrence, created_at FROM scheduled_transactions WHERE id = $id;";
        command.Parameters.AddWithValue("$id", scheduleId.ToString("D"));
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadScheduledTransaction(reader) : null;
    }

    private static void AddScheduledTransactionParameters(
        SqliteCommand command,
        ScheduledTransaction scheduledTransaction,
        bool includeCreatedAt = true)
    {
        command.Parameters.AddWithValue("$id", scheduledTransaction.Id.ToString("D"));
        command.Parameters.AddWithValue("$accountId", scheduledTransaction.AccountId.ToString("D"));
        command.Parameters.AddWithValue("$startDate", scheduledTransaction.StartDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$endDate", scheduledTransaction.EndDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$description", scheduledTransaction.Description);
        command.Parameters.AddWithValue("$amount", FormatMoney(scheduledTransaction.Amount));
        command.Parameters.AddWithValue("$categoryId", scheduledTransaction.CategoryId?.ToString("D") ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$notes", scheduledTransaction.Notes ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$recurrence", (int)scheduledTransaction.Recurrence);
        if (includeCreatedAt)
        {
            command.Parameters.AddWithValue("$createdAt", scheduledTransaction.CreatedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        }
    }

    private static void ConfigureScheduledTransactionInsert(SqliteCommand command, ScheduledTransaction scheduledTransaction)
    {
        command.CommandText = """
            INSERT INTO scheduled_transactions (id, account_id, start_date, end_date, description, amount, category_id, notes, recurrence, created_at)
            VALUES ($id, $accountId, $startDate, $endDate, $description, $amount, $categoryId, $notes, $recurrence, $createdAt);
            """;
        AddScheduledTransactionParameters(command, scheduledTransaction);
    }

    private static ScheduledTransaction ReadScheduledTransaction(SqliteDataReader reader) => new(
        Guid.Parse(reader.GetString(0)),
        Guid.Parse(reader.GetString(1)),
        DateOnly.ParseExact(reader.GetString(2), "yyyy-MM-dd", CultureInfo.InvariantCulture),
        reader.IsDBNull(3) ? null : DateOnly.ParseExact(reader.GetString(3), "yyyy-MM-dd", CultureInfo.InvariantCulture),
        reader.GetString(4),
        ParseMoney(reader.GetString(5)),
        reader.IsDBNull(6) ? null : Guid.Parse(reader.GetString(6)),
        reader.IsDBNull(7) ? null : reader.GetString(7),
        (ScheduledTransactionRecurrence)reader.GetInt32(8),
        DateTimeOffset.Parse(reader.GetString(9), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind));

    private static string FormatMoney(Money money) => money.Amount.ToString("G29", CultureInfo.InvariantCulture);

    private static Money ParseMoney(string value) => new(decimal.Parse(value, NumberStyles.Number, CultureInfo.InvariantCulture));
}
