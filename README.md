# Money Map

A local-first encrypted desktop app for tracking, modeling, and understanding personal finances.

Money Map is Windows-first, with Linux support planned. Its working desktop client uses React, Tauri, Rust, SQLCipher, and operating-system credential storage. Financial records stay in an encrypted local database.

## Current capabilities

- Dashboard with net worth, time-windowed income and spending, accounts, and recent transactions.
- Manual transaction CRUD, filtering, pagination, categories, calendar subtotals, and scheduled transactions.
- Manual balance adjustments retained as auditable financial records.
- Numerical scenario modeling.
- Sandbox-only account-connection validation in the development build.

## Project documentation

- [Product requirements](docs/PRODUCT-REQUIREMENTS.md)
- [Roadmap and UX backlog](docs/BACKLOG.md)
- [Developer guide](docs/DEVELOPER.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Release and versioning](docs/RELEASE.md)

## Builds

- Development / Sandbox: `artifacts\\windows\\dev\\MoneyMapDev.exe`
- Production: `artifacts\\windows\\release\\MoneyMap.exe`

Generated executables are deliberately excluded from Git. Published builds will be attached to versioned GitHub Releases after release validation.

## License

Money Map is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal, educational, research, hobby, and other noncommercial use is allowed under its terms. Commercial use requires separate written permission from the copyright holder.
