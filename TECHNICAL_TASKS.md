# Technology Task And Subtask List

## Scope

This backlog covers technology work only. It excludes fundraising, sales, legal advisory work, licensing applications, banking partnership negotiations, and customer research, except where those activities create direct engineering requirements.

## MVP Technology Backlog

### 1. Define Technical Architecture

- [ ] Choose initial architecture style for a partner-first SaaS orchestration layer.
  - [ ] Define core bounded contexts: organizations, wallets, payments, FX, compliance, accounting, audit, integrations.
  - [ ] Decide initial deployment model: single-tenant, multi-tenant, or hybrid.
  - [ ] Define tenant isolation requirements for corporate customers.
  - [ ] Define data residency and encryption requirements for EU customers.
  - [ ] Create high-level architecture diagram for frontend, backend, integration services, data stores, queues, and observability.
- [ ] Select core technology stack.
  - [ ] Choose backend language and framework.
  - [ ] Choose frontend framework and design system.
  - [ ] Choose primary database and migration tooling.
  - [ ] Choose queue/event bus for payment workflows and provider callbacks.
  - [ ] Choose object storage for reports, exports, and evidence files.
  - [ ] Choose infrastructure provider and IaC tooling.
- [ ] Define API strategy.
  - [ ] Create internal API conventions.
  - [ ] Create external API conventions for customer and partner integrations.
  - [ ] Define idempotency, pagination, filtering, versioning, and error formats.
  - [ ] Define webhook model for transaction and reconciliation events.

### 2. Build Engineering Foundation

- [ ] Create repository structure.
  - [ ] Add backend service workspace.
  - [ ] Add frontend application workspace.
  - [ ] Add shared types/schema workspace.
  - [ ] Add infrastructure workspace.
  - [ ] Add documentation workspace.
- [ ] Configure local development environment.
  - [ ] Add Docker Compose or equivalent local dependencies.
  - [ ] Add seeded local database data.
  - [ ] Add environment variable templates.
  - [ ] Add local mock services for custody, FX, bank, AML, and ERP integrations.
- [ ] Set up CI/CD.
  - [ ] Run linting, type checks, and tests on every pull request.
  - [ ] Add database migration checks.
  - [ ] Add dependency vulnerability scanning.
  - [ ] Add container image builds.
  - [ ] Add deployment workflow for dev, staging, and production.
- [ ] Set up environments.
  - [ ] Provision dev environment.
  - [ ] Provision staging environment.
  - [ ] Provision production environment.
  - [ ] Configure secrets management.
  - [ ] Configure backup and restore processes.

### 3. Model Core Treasury Domain

- [ ] Implement organization and legal-entity model.
  - [ ] Support corporate groups, subsidiaries, branches, and business units.
  - [ ] Store jurisdiction, base currency, tax identifiers, and ERP references.
  - [ ] Support entity-level permissions, policies, wallets, accounts, and ledgers.
- [ ] Implement user, role, and team model.
  - [ ] Support treasury users, approvers, finance users, auditors, admins, and integration users.
  - [ ] Support custom roles per organization.
  - [ ] Support segregation-of-duties constraints.
- [ ] Implement asset and token model.
  - [ ] Represent fiat currencies, EMTs, ARTs, stablecoins, and tokenized instruments.
  - [ ] Store chain, contract address, issuer, redemption currency, precision, and risk tags.
  - [ ] Store whether an asset is enabled for payments, custody, FX, or reporting only.
- [ ] Implement transaction and ledger model.
  - [ ] Represent payment intents, transfers, conversions, fees, adjustments, and reversals.
  - [ ] Implement immutable event history for every transaction.
  - [ ] Create double-entry internal ledger for balances and reconciliation.
  - [ ] Track on-chain transaction hashes, bank references, provider references, and ERP references.

### 4. Build Identity, Access, And Approval Controls

- [ ] Implement enterprise authentication.
  - [ ] Support email/password for early MVP.
  - [ ] Support SAML or OIDC SSO.
  - [ ] Support MFA.
  - [ ] Support session management and device tracking.
- [ ] Implement role-based access control.
  - [ ] Define permissions for viewing balances, initiating payments, approving payments, managing policies, managing providers, and exporting reports.
  - [ ] Enforce permissions at API level.
  - [ ] Enforce permissions in the UI.
- [ ] Implement approval workflows.
  - [ ] Support maker-checker payment approvals.
  - [ ] Support multi-approver thresholds by entity, asset, amount, corridor, and counterparty.
  - [ ] Support approval expiry and cancellation.
  - [ ] Add escalation and reminder events.
- [ ] Implement configuration-change approvals.
  - [ ] Require approvals for policy changes.
  - [ ] Require approvals for provider credential changes.
  - [ ] Require approvals for adding counterparties and wallets.

### 5. Build Wallet And Custody Orchestration

- [ ] Implement wallet registry.
  - [ ] Support custodial wallets from partner CASPs or banks.
  - [ ] Support entity-owned wallets where permitted.
  - [ ] Store wallet ownership, custody model, supported assets, chain, provider, and status.
- [ ] Implement custody-provider adapter interface.
  - [ ] Define standard methods for create wallet, get balance, initiate transfer, estimate fee, get transaction status, freeze wallet, and list transactions.
  - [ ] Define standard webhook handlers for transfer status, balance changes, and provider incidents.
  - [ ] Add idempotency keys and retry behavior.
- [ ] Build first custody-provider mock.
  - [ ] Simulate wallet creation.
  - [ ] Simulate stablecoin balances.
  - [ ] Simulate pending, confirmed, failed, and reversed transfers.
  - [ ] Simulate provider downtime and delayed callbacks.
- [ ] Integrate first real custody or bank partner sandbox.
  - [ ] Implement authentication and credential storage.
  - [ ] Implement wallet and balance reads.
  - [ ] Implement sandbox transfer initiation.
  - [ ] Implement webhook signature verification.
  - [ ] Map provider errors into platform error categories.

### 6. Build Asset, Provider, And Risk Registry

- [ ] Implement provider registry.
  - [ ] Store provider type: custodian, CASP, bank, issuer, FX, payment, AML, ERP.
  - [ ] Store jurisdiction, supervisory authority, supported services, supported assets, supported corridors, and operational status.
  - [ ] Store licensing and evidence metadata as structured fields.
- [ ] Implement asset eligibility registry.
  - [ ] Store permitted tokens per customer and entity.
  - [ ] Store issuer concentration limits.
  - [ ] Store chain eligibility and unsupported-chain blocks.
  - [ ] Store policy tags such as payment token, reporting only, investment instrument, restricted, deprecated.
- [ ] Implement monitoring hooks.
  - [ ] Track provider uptime.
  - [ ] Track failed request rates and latency.
  - [ ] Track disabled assets and provider incidents.
  - [ ] Trigger alerts when provider or asset status changes.

### 7. Build Payments And Transfer Workflows

- [ ] Implement payment creation.
  - [ ] Support intra-group transfers between legal entities.
  - [ ] Support external counterparty payments.
  - [ ] Support scheduled payments.
  - [ ] Support bulk payment upload.
  - [ ] Support invoice reference and internal memo fields.
- [ ] Implement payment validation.
  - [ ] Validate wallet ownership and asset support.
  - [ ] Validate available balance.
  - [ ] Validate entity, asset, corridor, counterparty, and amount policies.
  - [ ] Validate sanctions and AML screening status.
  - [ ] Validate required approvals before execution.
- [ ] Implement payment execution.
  - [ ] Create execution state machine: draft, submitted, pending approval, approved, executing, settled, failed, cancelled.
  - [ ] Add idempotent execution keys.
  - [ ] Add retry and timeout handling.
  - [ ] Persist provider references and on-chain references.
  - [ ] Emit audit and ledger events at every state transition.
- [ ] Implement payment tracking UI.
  - [ ] Show status timeline.
  - [ ] Show approvals and policy checks.
  - [ ] Show fees, network, provider, and settlement references.
  - [ ] Show exception reason and next action.

### 8. Build Fiat, FX, And Conversion Orchestration

- [ ] Implement conversion quote model.
  - [ ] Support stablecoin-to-fiat, fiat-to-stablecoin, stablecoin-to-stablecoin, and fiat-to-fiat quotes where providers support them.
  - [ ] Store quote expiry, provider, fees, spread, settlement method, and estimated settlement time.
  - [ ] Support customer-visible and internal quote details.
- [ ] Implement FX-provider adapter interface.
  - [ ] Define methods for request quote, accept quote, get status, cancel quote, and list settlement instructions.
  - [ ] Define error mapping and retry rules.
  - [ ] Support sandbox provider mocks.
- [ ] Implement conversion workflow.
  - [ ] Add approval requirements for conversion orders.
  - [ ] Add quote acceptance and expiry handling.
  - [ ] Add ledger entries for principal, fees, FX gain/loss, and settlement.
  - [ ] Add reconciliation against provider settlement events.
- [ ] Build routing comparison for MVP.
  - [ ] Compare available providers by cost, speed, asset, corridor, and risk tags.
  - [ ] Show selected route rationale in the UI.
  - [ ] Store routing decision for audit.

### 9. Build On-Chain Event Ingestion And Reconciliation

- [ ] Implement blockchain network connectors.
  - [ ] Select initial chain or chains supported by the first stablecoin provider.
  - [ ] Read balances for configured wallets.
  - [ ] Read token transfer events.
  - [ ] Normalize chain events into internal transaction events.
- [ ] Implement confirmation and finality handling.
  - [ ] Configure required confirmations per chain and asset.
  - [ ] Handle pending, confirmed, replaced, failed, and reorg scenarios.
  - [ ] Alert on delayed settlement.
- [ ] Implement reconciliation engine.
  - [ ] Match internal payment intents to provider events, on-chain events, and bank events.
  - [ ] Create exception cases for unmatched transactions, amount differences, missing fees, and stale pending transactions.
  - [ ] Add manual resolution workflow with full audit trail.
- [ ] Implement balance reconciliation.
  - [ ] Compare internal ledger balances with provider balances.
  - [ ] Compare provider balances with on-chain balances where available.
  - [ ] Generate daily balance snapshots.
  - [ ] Alert on balance breaks.

### 10. Build Compliance And Policy Engine

- [ ] Implement policy rules engine.
  - [ ] Support rules by entity, user, role, counterparty, asset, chain, provider, amount, corridor, and time.
  - [ ] Support hard blocks, approval requirements, warnings, and audit-only rules.
  - [ ] Add policy simulation before activation.
  - [ ] Version policies and preserve historical rule evaluation.
- [ ] Integrate sanctions and AML screening.
  - [ ] Add counterparty screening adapter interface.
  - [ ] Add blockchain analytics adapter interface.
  - [ ] Screen wallet addresses before first use.
  - [ ] Screen transactions before execution.
  - [ ] Store screening result, provider reference, risk score, and decision.
- [ ] Implement counterparty management.
  - [ ] Store legal counterparty records.
  - [ ] Store wallet addresses and bank details.
  - [ ] Store screening status and approval status.
  - [ ] Track changes with audit history.
- [ ] Implement risk alerts.
  - [ ] Alert on blocked addresses.
  - [ ] Alert on provider incident status.
  - [ ] Alert on concentration-limit breaches.
  - [ ] Alert on de-peg or disabled-asset status when data is available.

### 11. Build Accounting, ERP, And TMS Integrations

- [ ] Implement accounting classification model.
  - [ ] Support configurable classification per asset and entity: cash equivalent, financial asset, intangible, inventory, or custom.
  - [ ] Store chart-of-accounts mappings.
  - [ ] Store accounting treatment versions and effective dates.
- [ ] Implement journal-entry generation.
  - [ ] Generate entries for purchases, redemptions, transfers, fees, FX conversions, fair-value adjustments, and reversals.
  - [ ] Support entity, cost center, project, tax code, and intercompany dimensions.
  - [ ] Support approval status and export status.
- [ ] Implement export formats.
  - [ ] Create CSV export for MVP.
  - [ ] Create configurable flat-file export.
  - [ ] Create JSON API export.
  - [ ] Add export manifest with record counts and checksums.
- [ ] Build first ERP/TMS connector.
  - [ ] Pick one initial target: SAP, Oracle, NetSuite, Kyriba, Trovata, or generic SFTP.
  - [ ] Implement authentication and connectivity.
  - [ ] Push balance snapshots.
  - [ ] Push journal entries.
  - [ ] Pull chart-of-accounts or entity reference data if supported.
- [ ] Implement reconciliation reports.
  - [ ] Generate daily balance report.
  - [ ] Generate transaction activity report.
  - [ ] Generate unresolved exceptions report.
  - [ ] Generate accounting export status report.

### 12. Build Audit, Evidence, And Reporting Layer

- [ ] Implement immutable audit log.
  - [ ] Log user actions, API actions, provider callbacks, approvals, policy decisions, and configuration changes.
  - [ ] Include actor, timestamp, source IP, request ID, before/after metadata, and related object IDs.
  - [ ] Make audit events queryable and exportable.
  - [ ] Protect audit events from user modification.
- [ ] Implement evidence exports.
  - [ ] Export payment evidence package.
  - [ ] Export approval evidence package.
  - [ ] Export policy evaluation evidence package.
  - [ ] Export reconciliation evidence package.
- [ ] Implement reporting dashboard.
  - [ ] Show balances by entity, asset, provider, and jurisdiction.
  - [ ] Show payment volumes and settlement status.
  - [ ] Show exceptions and aging.
  - [ ] Show provider and asset status.
  - [ ] Show approval queue and SLA metrics.

### 13. Build Customer-Facing Application

- [ ] Implement treasury dashboard.
  - [ ] Show total balances by currency, asset, legal entity, and provider.
  - [ ] Show pending payments and approvals.
  - [ ] Show reconciliation exceptions.
  - [ ] Show risk and compliance alerts.
- [ ] Implement wallet and account views.
  - [ ] Show wallet balances.
  - [ ] Show wallet transactions.
  - [ ] Show custody provider and asset support.
  - [ ] Show reconciliation status.
- [ ] Implement payment screens.
  - [ ] Create single payment flow.
  - [ ] Create bulk payment upload flow.
  - [ ] Create scheduled payment flow.
  - [ ] Create approval review flow.
  - [ ] Create payment detail and evidence view.
- [ ] Implement policy administration screens.
  - [ ] Manage limits.
  - [ ] Manage allowed assets.
  - [ ] Manage allowed providers.
  - [ ] Manage approval thresholds.
  - [ ] Manage counterparty rules.
- [ ] Implement accounting and export screens.
  - [ ] View generated journal entries.
  - [ ] Review export batches.
  - [ ] Download reports.
  - [ ] Track ERP/TMS sync status.

### 14. Build Internal Operations Console

- [ ] Implement tenant management.
  - [ ] Create and configure customer tenants.
  - [ ] Manage feature flags.
  - [ ] Manage integration credentials.
  - [ ] View customer environment status.
- [ ] Implement provider operations.
  - [ ] View provider health.
  - [ ] Retry failed provider calls.
  - [ ] Reprocess callbacks.
  - [ ] Disable provider routes.
- [ ] Implement exception operations.
  - [ ] View payment exceptions.
  - [ ] View reconciliation breaks.
  - [ ] View screening escalations.
  - [ ] Assign and resolve operational cases.

### 15. Implement Security, Resilience, And Observability

- [ ] Implement application security baseline.
  - [ ] Encrypt data in transit.
  - [ ] Encrypt sensitive data at rest.
  - [ ] Use managed secrets and key rotation.
  - [ ] Add rate limiting and abuse protection.
  - [ ] Add secure headers and CSRF protection where relevant.
- [ ] Implement secure credential handling.
  - [ ] Store provider API keys in secrets manager.
  - [ ] Restrict access to production credentials.
  - [ ] Log credential access.
  - [ ] Rotate sandbox and production credentials.
- [ ] Implement observability.
  - [ ] Add structured logging.
  - [ ] Add metrics for API latency, workflow latency, provider latency, failures, and queue depth.
  - [ ] Add distributed tracing.
  - [ ] Add alerting for failed payments, stuck workflows, callback failures, balance breaks, and provider downtime.
- [ ] Implement resilience patterns.
  - [ ] Add idempotency for all money-moving operations.
  - [ ] Add retries with backoff for provider calls.
  - [ ] Add circuit breakers for degraded providers.
  - [ ] Add dead-letter queues for failed async jobs.
  - [ ] Add disaster recovery runbooks.

### 16. Build Testing And Quality System

- [ ] Add automated test coverage.
  - [ ] Unit test domain rules.
  - [ ] Integration test provider adapters.
  - [ ] Integration test payment workflows.
  - [ ] Integration test reconciliation.
  - [ ] End-to-end test critical UI flows.
- [ ] Add security testing.
  - [ ] Run dependency scanning.
  - [ ] Run static application security tests.
  - [ ] Run dynamic application security tests against staging.
  - [ ] Run secrets scanning.
  - [ ] Prepare penetration-test scope.
- [ ] Add data and ledger testing.
  - [ ] Test double-entry invariants.
  - [ ] Test balance snapshots.
  - [ ] Test transaction reversals.
  - [ ] Test partial failures and provider callback replay.
  - [ ] Test reconciliation exceptions.
- [ ] Add release readiness checks.
  - [ ] Create smoke tests.
  - [ ] Create staging test plan.
  - [ ] Create rollback plan.
  - [ ] Create operational acceptance checklist.

### 17. Prepare MVP Pilot Environment

- [ ] Configure first pilot tenant.
  - [ ] Add legal entities.
  - [ ] Add users and roles.
  - [ ] Add approval thresholds.
  - [ ] Add permitted assets and providers.
  - [ ] Add mock or sandbox counterparties.
- [ ] Configure first pilot corridor.
  - [ ] Enable one euro stablecoin or bank settlement token route.
  - [ ] Enable one USD stablecoin or USD settlement route if available.
  - [ ] Enable one fiat off-ramp or FX route.
  - [ ] Enable AML and sanctions screening in pre-execution mode.
- [ ] Run pilot dry runs.
  - [ ] Execute intra-group transfer in sandbox.
  - [ ] Execute counterparty payment in sandbox.
  - [ ] Execute conversion in sandbox.
  - [ ] Generate accounting export.
  - [ ] Generate audit evidence package.
  - [ ] Resolve a simulated reconciliation exception.

## Post-MVP Technology Backlog

### 18. Expand Provider And Asset Coverage

- [ ] Add second custody or bank provider.
  - [ ] Implement adapter.
  - [ ] Implement provider-specific status mapping.
  - [ ] Add provider health monitoring.
  - [ ] Add failover routing logic where supported.
- [ ] Add more stablecoin and settlement-token assets.
  - [ ] Add euro EMT options.
  - [ ] Add USD stablecoin options available through compliant channels.
  - [ ] Add bank-issued settlement-token support.
  - [ ] Add asset deprecation workflow.
- [ ] Add more blockchain networks.
  - [ ] Implement network connector.
  - [ ] Configure confirmations and fees.
  - [ ] Add network-level policy rules.
  - [ ] Add network incident handling.

### 19. Build Advanced Liquidity Tools

- [ ] Implement target-balance rules.
  - [ ] Set minimum and maximum buffers by entity, asset, and wallet.
  - [ ] Alert on surplus and deficit balances.
  - [ ] Recommend transfers to rebalance liquidity.
- [ ] Implement automated rebalancing.
  - [ ] Generate rebalancing proposals.
  - [ ] Require approval before execution.
  - [ ] Execute approved rebalancing transfers.
  - [ ] Record routing and policy decisions.
- [ ] Implement liquidity forecasting integration.
  - [ ] Pull forecast data from ERP/TMS.
  - [ ] Match forecasts to wallet and bank balances.
  - [ ] Show expected funding gaps.
  - [ ] Recommend just-in-time funding actions.

### 20. Build Tokenized Instrument Integration

- [ ] Model tokenized money-market and short-term instruments separately from payment stablecoins.
  - [ ] Store instrument type, issuer, liquidity terms, risk tags, and settlement windows.
  - [ ] Enforce separation between payment token balances and investment positions.
  - [ ] Support customer eligibility controls.
- [ ] Build investment-provider adapter interface.
  - [ ] Request subscription quote.
  - [ ] Submit subscription.
  - [ ] Request redemption.
  - [ ] Get position and valuation.
  - [ ] Receive lifecycle callbacks.
- [ ] Build policy controls for investment allocations.
  - [ ] Set concentration limits.
  - [ ] Set duration and liquidity limits.
  - [ ] Require additional approvals.
  - [ ] Generate accounting and reporting outputs.

### 21. Build Advanced Analytics And Scenario Modeling

- [ ] Implement cost and speed analytics.
  - [ ] Compare stablecoin settlement, bank wire, SEPA Instant, and FX routes.
  - [ ] Track realized fees and settlement times.
  - [ ] Create corridor-level performance reports.
- [ ] Implement counterparty and issuer exposure analytics.
  - [ ] Show exposure by issuer.
  - [ ] Show exposure by provider.
  - [ ] Show exposure by chain.
  - [ ] Show exposure by jurisdiction.
- [ ] Implement scenario modeling.
  - [ ] Model de-peg event impact.
  - [ ] Model provider outage impact.
  - [ ] Model FX-rate movement impact.
  - [ ] Model liquidity buffer changes.

### 22. Build Programmable Payment Workflows

- [ ] Add conditional-payment workflows.
  - [ ] Support escrow-like release conditions.
  - [ ] Support invoice milestone release.
  - [ ] Support delivery confirmation triggers.
  - [ ] Support manual override with approval.
- [ ] Add smart-contract integration where needed.
  - [ ] Define contract security requirements.
  - [ ] Add contract allowlist.
  - [ ] Add pre-execution simulation.
  - [ ] Add contract event reconciliation.
- [ ] Add supply-chain finance workflows.
  - [ ] Support approved-payable settlement.
  - [ ] Support early-payment discount logic.
  - [ ] Support counterparty onboarding controls.

### 23. Build Deeper Enterprise Integrations

- [ ] Add SCIM provisioning.
  - [ ] Sync users.
  - [ ] Sync groups.
  - [ ] Deactivate users automatically.
  - [ ] Map identity-provider groups to platform roles.
- [ ] Add GRC integration.
  - [ ] Export policy evidence.
  - [ ] Export control attestations.
  - [ ] Sync incidents and exceptions.
  - [ ] Support audit requests.
- [ ] Add additional ERP/TMS connectors.
  - [ ] Add SAP connector.
  - [ ] Add Oracle connector.
  - [ ] Add NetSuite connector.
  - [ ] Add Kyriba or Trovata connector.
  - [ ] Add generic SFTP connector.

### 24. Mature Operations And Compliance Technology

- [ ] Add case management.
  - [ ] Create cases from policy breaches.
  - [ ] Create cases from screening escalations.
  - [ ] Create cases from reconciliation exceptions.
  - [ ] Assign, comment, resolve, and export cases.
- [ ] Add incident management integration.
  - [ ] Connect alerts to PagerDuty, Opsgenie, or equivalent.
  - [ ] Link provider incidents to customer-facing status.
  - [ ] Create incident timeline records.
  - [ ] Generate post-incident reports.
- [ ] Add customer-facing status page.
  - [ ] Show platform status.
  - [ ] Show provider route status.
  - [ ] Show asset availability status.
  - [ ] Show maintenance windows.

## Suggested MVP Completion Criteria

- [ ] A pilot customer can sign in through enterprise authentication.
- [ ] A pilot customer can view entity-level balances from at least one wallet or custody provider sandbox.
- [ ] A pilot customer can initiate, approve, execute, and track a stablecoin transfer in sandbox.
- [ ] A pilot customer can request and execute one conversion route in sandbox.
- [ ] The system screens counterparties and transactions before execution.
- [ ] The system enforces policy limits and approval thresholds.
- [ ] The system records immutable audit events for money movement and configuration changes.
- [ ] The system reconciles internal ledger events against provider or on-chain events.
- [ ] The system exports journal entries and balance reports for ERP/TMS import.
- [ ] Internal operators can monitor provider health, retry failed jobs, and resolve reconciliation exceptions.

