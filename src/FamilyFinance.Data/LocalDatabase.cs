using System.Security.Cryptography;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.Data.Sqlite;

namespace FamilyFinance.Data;

/// <summary>
/// The local source-of-truth database. Its SQLCipher key is random and protected
/// with Windows DPAPI for the current Windows user; it is never hard-coded or
/// stored in the database itself.
/// </summary>
public sealed class LocalDatabase
{
    private const string PlaintextSqliteHeader = "SQLite format 3\0";
    private readonly string _databasePath;
    private readonly string _keyPath;
    private readonly byte[] _databaseKey;

    static LocalDatabase() => SQLitePCL.Batteries_V2.Init();

    public LocalDatabase(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("The Windows release uses Windows DPAPI to protect its local database key.");
        }

        _databasePath = Path.GetFullPath(databasePath);
        _keyPath = _databasePath + ".key.dpapi";
        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)!);
        _databaseKey = GetOrCreateDatabaseKey();
    }

    public SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = _databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate
        }.ToString());

        connection.Open();
        ApplyEncryptionKey(connection);
        EnableForeignKeys(connection);
        return connection;
    }

    /// <summary>
    /// Brings the local schema to the current version. Each migration and its history marker commit together,
    /// so an interrupted upgrade can safely be retried.
    /// </summary>
    public void Initialize()
    {
        DiscardLegacyPlaintextDemoDatabase();
        using var connection = OpenConnection();
        VerifyEncryptedDatabase(connection);
        EnsureMigrationHistory(connection);
        ApplyMigration(connection, 1, CreateInitialSchema);
        ApplyMigration(connection, 2, AddTransactionKind);
        ApplyMigration(connection, 3, AddScheduledTransactions);
        ApplyMigration(connection, 4, AddBalanceAdjustmentAuditColumns);
        ApplyMigration(connection, 5, AddScheduledTransactionPostings);
        ApplyMigration(connection, 6, AddImportedTransactionDeduplication);
    }

    [SupportedOSPlatform("windows")]
    private byte[] GetOrCreateDatabaseKey()
    {
        if (File.Exists(_keyPath))
        {
            try
            {
                var protectedKey = File.ReadAllBytes(_keyPath);
                var key = ProtectedData.Unprotect(protectedKey, optionalEntropy: null, DataProtectionScope.CurrentUser);
                if (key.Length != 32)
                {
                    throw new InvalidDataException("The local database key has an invalid length.");
                }

                return key;
            }
            catch (CryptographicException exception)
            {
                throw new InvalidOperationException("Family Finance could not unlock its local database key for this Windows user.", exception);
            }
        }

        var generatedKey = RandomNumberGenerator.GetBytes(32);
        var protectedGeneratedKey = ProtectedData.Protect(generatedKey, optionalEntropy: null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(_keyPath, protectedGeneratedKey);
        return generatedKey;
    }

    /// <summary>
    /// The pre-encryption development ledger contains only disposable demo data.
    /// It must not remain beside the encrypted database after this security change.
    /// </summary>
    private void DiscardLegacyPlaintextDemoDatabase()
    {
        if (!File.Exists(_databasePath) || !HasPlaintextSqliteHeader(_databasePath))
        {
            return;
        }
        SqliteConnection.ClearAllPools();
        File.Delete(_databasePath);
    }

    private static bool HasPlaintextSqliteHeader(string path)
    {
        var expected = Encoding.ASCII.GetBytes(PlaintextSqliteHeader);
        var buffer = new byte[expected.Length];
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return stream.Read(buffer, 0, buffer.Length) == expected.Length && buffer.SequenceEqual(expected);
    }

    private void ApplyEncryptionKey(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA key = {SqlCipherKeyLiteral()}; PRAGMA cipher_memory_security = ON;";
        command.ExecuteNonQuery();
    }

    private string SqlCipherKeyLiteral() => "'" + Convert.ToBase64String(_databaseKey) + "'";

    private static void VerifyEncryptedDatabase(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM sqlite_master;";
        command.ExecuteScalar();
    }

    private static void EnsureMigrationHistory(SqliteConnection connection)
    {
        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER NOT NULL PRIMARY KEY
            );
            """);
        transaction.Commit();
    }

    private static void CreateInitialSchema(SqliteConnection connection, SqliteTransaction transaction)
    {
        Execute(connection, transaction, """
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT NOT NULL PRIMARY KEY,
                name TEXT NOT NULL,
                type INTEGER NOT NULL CHECK (type IN (0, 1, 2, 3, 4, 5, 6, 7)),
                opening_balance TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS categories (
                id TEXT NOT NULL PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT NOT NULL PRIMARY KEY,
                account_id TEXT NOT NULL,
                transaction_date TEXT NOT NULL,
                description TEXT NOT NULL,
                amount TEXT NOT NULL,
                category_id TEXT NULL,
                notes TEXT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(account_id) REFERENCES accounts(id),
                FOREIGN KEY(category_id) REFERENCES categories(id)
            );

            CREATE INDEX IF NOT EXISTS ix_transactions_account_date
                ON transactions(account_id, transaction_date);
            """);
    }

    private static void AddTransactionKind(SqliteConnection connection, SqliteTransaction transaction)
    {
        if (!ColumnExists(connection, transaction, "transactions", "transaction_kind"))
        {
            Execute(connection, transaction, "ALTER TABLE transactions ADD COLUMN transaction_kind INTEGER NOT NULL DEFAULT 0;");
        }
    }

    private static void AddScheduledTransactions(SqliteConnection connection, SqliteTransaction transaction) =>
        Execute(connection, transaction, """
            CREATE TABLE IF NOT EXISTS scheduled_transactions (
                id TEXT NOT NULL PRIMARY KEY,
                account_id TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NULL,
                description TEXT NOT NULL,
                amount TEXT NOT NULL,
                category_id TEXT NULL,
                notes TEXT NULL,
                recurrence INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(account_id) REFERENCES accounts(id),
                FOREIGN KEY(category_id) REFERENCES categories(id)
            );

            CREATE INDEX IF NOT EXISTS ix_scheduled_transactions_account_start
                ON scheduled_transactions(account_id, start_date);

            CREATE TABLE IF NOT EXISTS scheduled_transaction_skips (
                scheduled_transaction_id TEXT NOT NULL,
                occurrence_date TEXT NOT NULL,
                skipped_at TEXT NOT NULL,
                reason TEXT NULL,
                PRIMARY KEY(scheduled_transaction_id, occurrence_date),
                FOREIGN KEY(scheduled_transaction_id) REFERENCES scheduled_transactions(id)
            );
            """);

    private static void AddBalanceAdjustmentAuditColumns(SqliteConnection connection, SqliteTransaction transaction)
    {
        if (!ColumnExists(connection, transaction, "transactions", "balance_before_adjustment"))
        {
            Execute(connection, transaction, "ALTER TABLE transactions ADD COLUMN balance_before_adjustment TEXT NULL;");
        }

        if (!ColumnExists(connection, transaction, "transactions", "target_balance"))
        {
            Execute(connection, transaction, "ALTER TABLE transactions ADD COLUMN target_balance TEXT NULL;");
        }
    }

    private static void AddScheduledTransactionPostings(SqliteConnection connection, SqliteTransaction transaction) =>
        Execute(connection, transaction, """
            CREATE TABLE IF NOT EXISTS scheduled_transaction_postings (
                scheduled_transaction_id TEXT NOT NULL,
                occurrence_date TEXT NOT NULL,
                transaction_id TEXT NOT NULL UNIQUE,
                posted_at TEXT NOT NULL,
                PRIMARY KEY(scheduled_transaction_id, occurrence_date),
                FOREIGN KEY(scheduled_transaction_id) REFERENCES scheduled_transactions(id),
                FOREIGN KEY(transaction_id) REFERENCES transactions(id)
            );

            CREATE TRIGGER IF NOT EXISTS prevent_skip_of_posted_scheduled_occurrence
            BEFORE INSERT ON scheduled_transaction_skips
            WHEN EXISTS (
                SELECT 1 FROM scheduled_transaction_postings
                WHERE scheduled_transaction_id = NEW.scheduled_transaction_id
                  AND occurrence_date = NEW.occurrence_date)
            BEGIN
                SELECT RAISE(ABORT, 'A posted occurrence cannot be skipped.');
            END;

            CREATE TRIGGER IF NOT EXISTS prevent_post_of_skipped_scheduled_occurrence
            BEFORE INSERT ON scheduled_transaction_postings
            WHEN EXISTS (
                SELECT 1 FROM scheduled_transaction_skips
                WHERE scheduled_transaction_id = NEW.scheduled_transaction_id
                  AND occurrence_date = NEW.occurrence_date)
            BEGIN
                SELECT RAISE(ABORT, 'A skipped occurrence cannot be posted.');
            END;
            """);

    private static void AddImportedTransactionDeduplication(SqliteConnection connection, SqliteTransaction transaction) =>
        Execute(connection, transaction, """
            CREATE TABLE IF NOT EXISTS imported_transactions (
                provider TEXT NOT NULL,
                provider_transaction_id TEXT NOT NULL,
                connection_id TEXT NOT NULL,
                transaction_id TEXT NOT NULL UNIQUE,
                imported_at TEXT NOT NULL,
                PRIMARY KEY(provider, provider_transaction_id),
                FOREIGN KEY(transaction_id) REFERENCES transactions(id)
            );
            """);

    private static void ApplyMigration(
        SqliteConnection connection,
        int version,
        Action<SqliteConnection, SqliteTransaction> apply)
    {
        using var transaction = connection.BeginTransaction();
        if (HasMigration(connection, transaction, version))
        {
            transaction.Commit();
            return;
        }

        apply(connection, transaction);
        Execute(connection, transaction, "INSERT INTO schema_migrations(version) VALUES ($version);", ("$version", version));
        transaction.Commit();
    }

    private static bool HasMigration(SqliteConnection connection, SqliteTransaction transaction, int version)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM schema_migrations WHERE version = $version;";
        command.Parameters.AddWithValue("$version", version);
        return command.ExecuteScalar() is not null;
    }

    private static bool ColumnExists(SqliteConnection connection, SqliteTransaction transaction, string tableName, string columnName)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"PRAGMA table_info({tableName});";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static void Execute(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string commandText,
        params (string Name, object Value)[] parameters)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = commandText;
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        command.ExecuteNonQuery();
    }

    private static void EnableForeignKeys(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys = ON;";
        command.ExecuteNonQuery();
    }
}
