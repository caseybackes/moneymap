# Money Map — Product and UX Backlog

This is a decision and implementation queue. Items are intentionally recorded before a build pass; no item is an authorization to change behavior without its stated decision being made.

## Current UI pass

- [ ] **First-run onboarding** — Add a brief, dismissible first-run sequence after the first-launch dashboard is useful on its own. It should explain local encrypted storage, connecting an account versus manual entry, and where to find the ledger/calendar. It must never block normal use or require a financial connection.
- [ ] **First-party confirmation coverage** — The app-styled confirmation dialog now handles institution disconnect. Replace remaining browser-native confirmations, including transaction deletion, and apply the same treatment to future destructive actions.
- [ ] **Navigation visual direction** — Decide between a refined fixed side rail and top tabs before restructuring navigation. Adopt a coherent free icon set with clear labels/tooltips; candidate implementation source: Lucide (MIT).
- [ ] **Settings and About** — Add a Settings route with persisted user preferences, initially font-size selection and an About/build-information panel. Build information shows product version, build channel (`Dev` or `Production`), build timestamp/commit where available, desktop/runtime versions, and key dependency versions relevant to support.
- [ ] **Bottom-of-rail profile menu** — Place a persistent user-profile icon at the bottom of the fixed navigation rail, visually separated from primary view icons. Clicking it opens an anchored account/options menu, similar in interaction to the desktop ChatGPT profile menu. Initial items: Profile and goals, AI-memory/privacy controls, Settings, Appearance, and About/build information. It remains visible while page content scrolls and light-dismisses when the user clicks elsewhere.
- [ ] **Appearance themes** — Add locally persisted color-theme selection through the profile menu's Appearance entry. Ship a small curated set of accessible themes, including the current dark theme, and apply the choice consistently to application background, widgets, navigation rail, controls, charts, and status states without changing financial data or behavior.

## Environment boundary (decision and implementation design)

- [ ] **Two deployments, two app configurations** — Dev uses a Sandbox-only Worker deployment, Sandbox credentials, development bundle identifier/data directory, and a visible `Development / Sandbox` marker. Production uses a separate Worker deployment, production-only credentials, production bundle identifier/data directory, and has no Sandbox bootstrap/reset route compiled into the app. This is build configuration, not a runtime toggle.
- [ ] **No credential crossover** — A production build rejects Sandbox endpoints and Sandbox Link tokens; a dev build has no production broker URL or production secret path. CI/build validation fails if environments are crossed.

## Release identity and versioning

- [ ] **Version provenance** — Generate a build-info record at publish time. It carries the semantic version, channel, build UTC timestamp, source commit, Rust/Tauri/React/Node versions, and a dependency-lockfile fingerprint. Surface it read-only in Settings/About and include it in diagnostics without exposing secrets or financial data.
- [ ] **Settings storage** — Persist user preferences in the local encrypted application database or a dedicated local settings store under the application-data directory. User settings are runtime data, never source files.

## Linux delivery (deferred)

- [ ] **Linux release channel** — The React/Tauri application code and SQLCipher data model are shared with Windows; Linux work is a release/runtime-validation gap. Add a Linux publish workflow, beginning with an AppImage or equivalent broadly portable package, plus a fixed Linux artifact location and release asset/checksum process.
- [ ] **Linux runtime validation** — Smoke-test the packaged client on a real Linux desktop. Verify window behavior, encrypted-database startup/restart, credential-store behavior, manual ledger workflows, and the no-network local-first path before claiming Linux support.
- [ ] **Linux credential-store support decision** — Validate the existing Linux keyring backend across supported desktop environments. Document supported secret-service prerequisites and a recovery path before enabling connected-account flows on Linux.

## Analytics as the primary product value

Data connection and manual entry are ingestion paths. The product's central value is a trustworthy analysis layer over the user's complete financial picture.

- [ ] **Explainable forward net-worth forecast** — Extend the Dashboard Net worth widget into one continuous actual-and-forecast chart. The user selects a forward horizon from 1 month through 5 years; the chart retains historical actual balances through today, then projects the local financial picture forward. Keep the existing period controls and show selected-period income, spending, and net flow in the same widget.
- [ ] **Forecast inputs and calibration** — Project known cash flows deterministically from selected connected accounts, manual balances, scheduled transactions, and user-confirmed future events. Add a transparent time-series baseline for recurring or seasonal cash flow that is not explicitly scheduled, with separate confidence/freshness indicators. Users must be able to confirm, edit, exclude, or override every inferred forecast input.
- [ ] **Material-event annotations** — Mark material forecast rises and drops directly on the chart. A compact `?` affordance on each marker opens an explanation showing the contributing transactions/events, amounts, dates, whether each input is observed, scheduled, or estimated, and its effect on projected net worth.
- [ ] **Tax-aware event modeling** — Support user-entered or explicitly confirmed tax obligations, withholding, refunds, and payment dates as forecast events. Do not infer a tax liability solely from bank transactions; show tax estimates and assumptions separately from confirmed tax payments.
- [ ] **Payroll-income data discovery** — Evaluate whether Plaid Income / Payroll Income can responsibly add pay, withholding, and employer-payroll facts to a local Money Map profile. Confirm current product access, ADP coverage, permitted personal-finance use, cost, consent wording, local encryption/retention, and manual fallback before any integration. The existing Transactions connection does not provide this payroll data.
- [ ] Cluster merchant/payee variants and show explainable category proposals that learn from explicit user corrections.
- [ ] Show category spending, income, cash flow, and trends over selectable time ranges with drill-down to the underlying transactions.
- [ ] Detect recurring payments, unusual changes, and emerging spend patterns with evidence and user approval before any record changes.
- [ ] Keep what-if modeling numerical and structured; provide AI interpretation only after the scenario calculation is complete.
- [ ] Later: offer evidence-backed financial opportunity analysis across user-provided account, insurance, and tax information: possible savings, coverage gaps, and tax-impact questions. Present assumptions, confidence, and caveats; require user review and never perform an action automatically.
- [ ] Define the privacy/consent model before any external AI receives financial data. Preserve local-first operation when no provider is configured.

## AI financial-planning harness (discovery before implementation)

The goal is a user-controlled planning partner that connects the user's full financial picture: banking, credit, insurance, investments, taxes, credit health, and stated goals. It produces evidence-linked observations, questions, options, and numerical plans; it does not initiate financial, insurance, tax, or investment actions.

- [ ] **Financial profile and goals** — Model the user's household-independent objectives, constraints, time horizon, risk preferences, life events, and explicit corrections. Each app installation remains one independent profile; a family member uses their own installation/profile.
- [ ] **Structured financial facts** — Keep canonical balances, transactions, holdings, coverage, tax inputs, and source dates in the encrypted local database. AI summaries and memories must link back to source records, carry confidence/freshness, and never become the authoritative financial record.
- [ ] **Action-item engine** — Surface prioritised opportunities and questions across categories such as cash flow, debt, insurance coverage, tax planning, and investments. Every item must show its inputs, assumptions, numerical effect where calculable, and a user-approved status; retain a decision history.
- [ ] **Cross-domain planning workspace** — Add dedicated domain views and structured inputs for insurance, investments/retirement, taxes, credit/debt, and benefits as the relevant data model matures. Their purpose is to complete the user's financial picture and support cross-domain planning, not to create disconnected dashboards.
- [ ] **Decision-ready planning brief** — Turn the highest-value observations into a concise plan: material issue/opportunity, evidence, cross-domain linkage, assumptions, numerical scenarios, unanswered questions, next action, and recommended professional review where appropriate.
- [ ] **AI conversation and memory** — Make long-lived conversational memory optional and inspectable. Separate explicit user preferences/goals, verified financial facts, derived summaries, and conversation history; allow view, correction, export, and deletion for each class.
- [ ] **Local-only memory baseline** — Store structured memory, summaries, source links, retrieval indexes, and any embeddings inside the encrypted local database. Treat embeddings as sensitive derived financial data. Any index must be rebuildable from encrypted canonical records; no memory service, vector store, or Cloudflare storage is required.
- [ ] **Local-only privacy mode** — Define a strict mode in which financial records, memory, retrieval, embeddings, and AI inference remain on-device with no outbound requests. A mode that uses cloud inference while retaining memory locally must disclose that retrieved context is still sent to the selected provider.
- [ ] **Provider-agnostic AI contract** — Define model, embedding, tool-calling, and streaming interfaces independent of a specific provider. Support local inference and user-supplied providers before considering a managed service.
- [ ] **AI tool boundary** — Expose narrowly typed, permission-scoped tools such as read financial summary, retrieve cited transactions, run a numerical scenario, and draft an action item. Tool calls must be auditable and no tool may mutate financial data or trigger an external action without explicit user confirmation.
- [ ] **Cloud AI tier decision** — If a managed tier is offered, use a dedicated broker boundary for authentication, provider credentials, rate limits, billing/metering, and request audit metadata. Define data minimization, per-request consent, retention, encryption/key ownership, deletion, and provider terms before sending financial context off-device.
- [ ] **Memory framework evaluation** — Evaluate Hindsight, Holographic Memory, and similar systems only against the above portability, encryption, deletion, provenance, and provider-agnostic requirements. Do not make a framework the canonical store or provider lock-in point.
- [ ] **MCP and skills boundary** — Application runtime capabilities use typed app tools. MCP is a later optional integration surface for external agents; coding-agent skills are development tooling and are not the Money Map end-user AI runtime.
- [ ] **Advice safety and review** — Present planning output as decision support with uncertainty and source citations. For tax, insurance, investment, or legal decisions, prompt the user to review with the appropriate qualified professional where warranted.
