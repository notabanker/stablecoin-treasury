# Fable5 Technical Gap Planning Brief

Purpose: give Fable5 enough context to produce a detailed technology task/subtask backlog for turning this prototype into a credible production-grade fintech MVP foundation.

Audience: senior software architect, staff engineer, fintech platform lead, database architect, security engineer.

Project path:

```text
/Users/notabanker/projects/corporate-stablecoin-treasury-platform
```

## 1. Objective For Fable5

Create a detailed, prioritized task and subtask plan for closing the remaining technical, database, reliability, security, and operational gaps in the Corporate Stablecoin Treasury Platform.

The output should not be a general essay. It should be an executable engineering backlog with:

- Epics
- Tasks
- Subtasks
- Dependencies
- Acceptance criteria
- Suggested implementation order
- Risk level
- Estimated complexity
- Files/components likely affected
- Tests required
- Clear "definition of done" per task

Assume the goal is to evolve the current local prototype into a production-capable MVP foundation suitable for regulated pilots, not full global enterprise scale on day one.

## 2. Current System Snapshot

The current app is a Node.js microservices prototype with:

- Static web UI in `apps/web`.
- API gateway/BFF in `services/api-gateway`.
- Domain services:
  - `wallet-service`
  - `policy-service`
  - `compliance-service`
  - `payment-service`
  - `accounting-service`
  - `reconciliation-service`
  - `operations-service`
- Shared helpers in `packages/shared`.
- Local JSON persistence under `.data`.
- Dockerfile and Docker Compose for local orchestration.
- No third-party npm dependencies.
- No real database.
- No auth.
- No tenant model.
- No real regulated provider integrations.

Important docs to read before planning:

```text
README.md
docs/ARCHITECTURE.md
docs/PRODUCTION_READINESS.md
docs/ONBOARDING.md
TECHNICAL_TASKS.md
```

Important implementation files:

```text
apps/web/main.js
apps/web/styles.css
services/api-gateway/src/index.mjs
services/wallet-service/src/index.mjs
services/policy-service/src/index.mjs
services/compliance-service/src/index.mjs
services/payment-service/src/index.mjs
services/accounting-service/src/index.mjs
services/reconciliation-service/src/index.mjs
services/operations-service/src/index.mjs
packages/shared/data.mjs
packages/shared/http.mjs
packages/shared/service-client.mjs
packages/shared/store.mjs
scripts/dev.mjs
scripts/smoke.mjs
docker-compose.yml
```

## 3. Recently Fixed Issues

Do not plan these as if they are still completely unfixed, but you may plan hardening around them:

- Wallet debit now rejects non-finite and non-positive amounts.
- Wallet debit now rejects inactive wallets.
- Payment execution no longer re-runs policy after a payment is already in `Executing`.
- Generated accounting journal batches now balance amount plus fee.
- Seed journal data was corrected for the fee credit.
- Review policy decisions now block approval/execution.
- Some policy fields are now enforced: approval thresholds, provider allowlist, screening requirement, transfer limit EUR conversion, and concentration checks.
- Docker Compose no longer publishes internal service ports `4101-4107`; only gateway `8080` is published.

Still assume these fixes are prototype-level and need test coverage, formal invariants, and production-grade persistence.

## 4. Planning Rules

When creating the task list:

1. Separate prototype cleanup from production MVP foundations.
2. Prioritize money safety before UI polish.
3. Prioritize database correctness before adding more product features.
4. Every task that touches balances, payments, approvals, accounting, or audit must include tests.
5. Every service boundary must have an explicit contract.
6. Every externally callable endpoint must have auth, authorization, validation, and observability tasks.
7. Every data mutation must have idempotency and recovery behavior defined.
8. Do not assume JSON files can remain as production persistence.
9. Do not assume synchronous request chains are acceptable for money movement.
10. Do not include real secrets, API keys, passwords, private keys, or production credentials.

## 5. Required Output Format

Fable5 should produce a backlog in this structure:

```markdown
# Production MVP Technical Backlog

## Milestone 0: Stabilize Prototype

### Epic 0.1: ...

#### Task 0.1.1: ...
- Priority:
- Risk:
- Dependencies:
- Components:
- Subtasks:
  - [ ] ...
  - [ ] ...
- Acceptance Criteria:
  - [ ] ...
- Tests:
  - [ ] ...
- Definition of Done:
  - [ ] ...

## Milestone 1: Database Foundation
...

## Milestone 2: Money Movement Safety
...

## Milestone 3: Security, Identity, And Tenant Isolation
...

## Milestone 4: Regulated Integrations
...

## Milestone 5: Production Operations
...
```

Use priorities:

```text
P0 = must fix before any pilot with real money
P1 = must fix before regulated design partner pilot
P2 = should fix before seed-scale production
P3 = later hardening or scale improvement
```

Use complexity:

```text
S = 1-2 days
M = 3-7 days
L = 1-3 weeks
XL = multi-week/multi-team
```

## 6. Open Technical And Database Gaps

### 6.1 Persistence And Database

Current state:

- Each service writes mutable JSON files in `.data`.
- There is no relational schema.
- There are no migrations.
- There are no database constraints.
- There are no transactions.
- There is no PITR, backup, restore, or retention plan.

Required planning:

- Replace JSON stores with PostgreSQL or equivalent production database.
- Decide between database-per-service, schema-per-service, or shared cluster with strict ownership.
- Create migrations for every service.
- Add migration tooling.
- Add schema validation and DB-level constraints.
- Add local seed data through migrations or seed scripts.
- Add test database setup/teardown.
- Add backup, restore, retention, and disaster-recovery tasks.
- Add encrypted storage and secrets-managed database credentials.

Minimum database domains to model:

```text
identity:
  tenants
  users
  roles
  permissions
  sessions/service_accounts

wallet:
  legal_entities
  assets
  wallets
  ledger_accounts
  ledger_entries
  wallet_balance_snapshots

payment:
  payments
  payment_events
  payment_approvals
  idempotency_keys
  payment_execution_attempts

policy:
  policy_versions
  policy_rules
  policy_decisions

compliance:
  counterparties
  screening_requests
  screening_results
  sanctions_hits
  review_cases

accounting:
  journal_batches
  journal_lines
  export_batches
  export_attempts

reconciliation:
  provider_statements
  reconciliation_matches
  reconciliation_exceptions
  exception_actions

operations:
  providers
  incidents
  alerts
  audit_events

platform:
  outbox_events
  inbox_events
  webhook_events
  jobs
  job_attempts
```

### 6.2 Ledger And Balance Integrity

Current state:

- Wallet balances are mutable numeric fields.
- Payment execution directly debits a wallet balance.
- No append-only double-entry ledger exists.
- Balances are not derived from ledger entries.

Required planning:

- Introduce append-only ledger entries.
- Model ledger accounts per tenant/entity/wallet/asset.
- Make every balance movement double-entry.
- Ensure debits equal credits for every ledger transaction.
- Make balances derived or reconciled from immutable entries.
- Add DB constraints for non-negative amounts and valid asset/currency codes.
- Add idempotent ledger transaction creation.
- Add ledger balance snapshots for performance.
- Add balance recalculation tooling.
- Add tests proving no malformed request can corrupt balances.
- Add tests proving concurrent debits cannot overdraft a wallet.

### 6.3 Payment State Machine

Current state:

- Payment lifecycle is implemented through ad hoc status strings.
- Allowed transitions are not centralized.
- Recovery states are limited.
- Failed/executing/repair flows are incomplete.

Required planning:

- Define formal payment statuses:

```text
Draft
PendingApproval
Approved
Executing
SettlementPending
Settled
Failed
RepairRequired
Cancelled
Rejected
Expired
```

- Create a state transition table.
- Enforce transitions in code and database.
- Persist payment events.
- Add transition reason codes.
- Add recovery actions for stuck `Executing`, provider timeout, accounting failure, reconciliation failure, and webhook mismatch.
- Add tests for every allowed and disallowed transition.

### 6.4 Distributed Transactions, Saga, And Outbox

Current state:

- Payment execution is still mostly synchronous across services.
- State can diverge if downstream services fail after one service commits.
- There is no outbox/inbox.
- There is no durable job queue.

Required planning:

- Add transactional outbox table per writing service.
- Add inbox/idempotency table per consuming service.
- Add event relay worker.
- Add durable job worker for payment execution.
- Convert payment execution from synchronous request chain to saga/workflow.
- Add retry policies, dead-letter queues, and operator repair UI.
- Define compensating actions.
- Add exactly-once effect through idempotency, not exactly-once delivery.
- Add event schemas and versioning.
- Add replay tooling.
- Add failure-injection tests.

Required event examples:

```text
payment.created
payment.approved
payment.rejected
payment.execution_requested
wallet.debit_reserved
wallet.debit_committed
payment.settlement_submitted
payment.settled
accounting.journal_created
reconciliation.match_created
reconciliation.exception_opened
audit.event_recorded
```

### 6.5 Idempotency And Concurrency

Current state:

- Some idempotency exists but is not backed by database constraints.
- Concurrent create/approve/execute behavior is not formally protected.
- Payment references can collide under concurrent creation.

Required planning:

- Store idempotency keys with tenant, actor, endpoint/action, request hash, response pointer, and expiry.
- Add unique DB constraints for idempotency keys and payment references.
- Add request-hash mismatch detection.
- Add optimistic locking or row-level locks on payments and wallets.
- Add concurrency tests for duplicate payment create, duplicate approval, duplicate execution, debit replay, and timeout retry.
- Ensure retries never create duplicate ledger entries, journal entries, reconciliation rows, or provider calls.

### 6.6 Accounting

Current state:

- Journal generation now balances basic batches, but accounting is still minimal.
- No posting periods.
- No chart of accounts.
- No ERP export files.
- No FX accounting.
- No receiving-entity mirror for intercompany transfers.

Required planning:

- Model chart of accounts.
- Model accounting configuration per tenant/entity.
- Enforce balanced journal batches at DB and service levels.
- Add posting period controls.
- Add journal batch immutability after export.
- Add reversal entries instead of mutation.
- Add intercompany mirror entries.
- Add fee accounting policy.
- Add FX rate source and realized/unrealized gain/loss handling.
- Add ERP export adapters.
- Add export attempt tracking and retry handling.
- Add tests proving every journal batch balances.

### 6.7 Policy Engine

Current state:

- Policy checks are now more real but still hardcoded.
- No policy versioning.
- No policy simulation.
- No policy decision persistence.
- No maker/checker process for policy changes.

Required planning:

- Create versioned policy model.
- Persist every policy decision with policy version, input hash, checks, result, actor, and timestamp.
- Add rule registry.
- Add policy simulation endpoint.
- Add maker/checker approval for policy changes.
- Add policy effective dates.
- Add policy rollback.
- Add tests for thresholds, provider allowlist, concentration, screening requirement, hard limits, asset allowlist, and review routing.

### 6.8 Identity, Auth, RBAC, And Tenant Isolation

Current state:

- No authentication.
- No authorization.
- Hardcoded actor names.
- No tenant IDs.
- No service-to-service auth.
- Audit records are actor strings, not verified identities.

Required planning:

- Add tenant/organization model.
- Add user model.
- Add SSO/OIDC/SAML integration plan.
- Add session or token validation.
- Add RBAC permissions:

```text
payment:create
payment:approve
payment:execute
payment:cancel
wallet:read
policy:read
policy:update
provider:read
provider:update
reconciliation:resolve
accounting:export
audit:read
admin:manage_users
```

- Add service-to-service authentication.
- Add tenant ownership checks on every query and mutation.
- Consider PostgreSQL Row-Level Security.
- Add tests proving cross-tenant access fails.
- Add four-eyes approval enforcement:
  - Creator cannot approve own payment above configured threshold.
  - Same user cannot approve twice.
  - Approver must have permission and limit.
  - Approval must persist user identity and timestamp.

### 6.9 Audit Immutability

Current state:

- Audit events are mutable JSON rows.
- Any caller can forge actor identity today unless gateway/auth is added.
- No tamper evidence.

Required planning:

- Make audit events append-only.
- Include verified actor ID, tenant ID, request ID, IP/user agent where applicable, action, object, before/after hash, and timestamp.
- Add hash chain or event signature.
- Add WORM/export path if required.
- Block update/delete of audit events.
- Add audit search APIs.
- Add audit retention policy.
- Add tests proving audit cannot be modified through application APIs.

### 6.10 API Design And Validation

Current state:

- Hand-rolled HTTP router.
- No OpenAPI spec.
- No request/response schemas.
- No typed DTOs.
- Validation is inconsistent.

Required planning:

- Add schema validation library or structured validation layer.
- Add OpenAPI spec.
- Add request and response schemas for all endpoints.
- Add standardized error format.
- Add API versioning.
- Add pagination, filtering, sorting for list endpoints.
- Add correlation/request IDs.
- Add rate limiting.
- Add contract tests.
- Add client generation or typed API client.

### 6.11 Provider Integrations

Current state:

- Providers are seeded demo records.
- No real custody/CASP/bank/AML/FX/issuer integrations.
- No webhook ingestion.
- No signed callback verification.

Required planning:

- Define provider adapter interface.
- Add provider capability model.
- Add sandbox/prod environment separation.
- Add secure credential storage.
- Add custody adapter.
- Add AML/sanctions screening adapter.
- Add stablecoin issuer or CASP adapter.
- Add FX/conversion adapter.
- Add bank/off-ramp adapter.
- Add ERP/TMS adapter.
- Add webhook endpoint with signature verification.
- Add webhook event persistence and replay.
- Add provider health checks.
- Add provider circuit breakers.
- Add integration contract tests and sandbox tests.

### 6.12 Reconciliation

Current state:

- Reconciliation rows are demo records.
- No provider statement ingestion.
- No bank/chain/custody matching.
- No aging engine.

Required planning:

- Add statement/import model.
- Add provider callback ingestion.
- Add chain event ingestion if applicable.
- Add matching rules.
- Add exception lifecycle.
- Add aging calculation from timestamps instead of static `ageHours`.
- Add owner assignment.
- Add resolution evidence attachments/notes.
- Add reconciliation dashboards.
- Add tests for matched, missing, duplicate, amount mismatch, fee mismatch, and late callback scenarios.

### 6.13 Frontend Product Gaps

Current state:

- Functional static UI.
- No auth screens.
- No role-based rendering.
- Limited error recovery.
- No stuck-payment repair UI.
- No policy simulation UI.
- No audit search UI.

Required planning:

- Add authenticated app shell.
- Add tenant/user context.
- Add permission-aware controls.
- Add loading and error states for stale refresh failures.
- Add repair queue for failed/stuck payments.
- Add approval inbox.
- Add policy version/history UI.
- Add audit search and export UI.
- Add reconciliation detail workflow.
- Add provider integration settings screens.
- Add accessible form validation.
- Add e2e tests.

### 6.14 Observability

Current state:

- Basic structured logs and `/metrics`.
- No tracing.
- No dashboards.
- No alerting.
- No SLOs.

Required planning:

- Add OpenTelemetry traces across gateway and services.
- Add metrics for payment lifecycle, failed transitions, provider latency, queue depth, webhook failures, reconciliation exceptions, and accounting export failures.
- Add log redaction.
- Add centralized logging.
- Add dashboards.
- Add alerts and runbooks.
- Add synthetic checks.
- Add audit/security event monitoring.

### 6.15 Security Engineering

Current state:

- No secrets manager.
- No dependency scanning.
- No SAST/DAST.
- No CSRF strategy.
- CORS can default to wildcard.
- No production security headers.

Required planning:

- Add secrets management.
- Add environment separation.
- Add TLS/HTTPS strategy.
- Add strict CORS.
- Add CSRF protection if cookie-based auth is used.
- Add security headers.
- Add rate limiting.
- Add request body limits per route.
- Add dependency scanning.
- Add SAST.
- Add secrets scanning.
- Add container scanning.
- Add threat model.
- Add security tests.

### 6.16 Infrastructure And Deployment

Current state:

- Local dev script.
- Dockerfile and Compose only.
- No IaC.
- No CI/CD.
- No production deployment topology.

Required planning:

- Add CI pipeline.
- Add build/test/lint stages.
- Add Docker image build and scan.
- Add IaC, likely Terraform or Pulumi.
- Define environments:
  - local
  - dev
  - staging
  - production
- Add environment config management.
- Add Kubernetes/ECS/Fly/Render/Cloud Run deployment decision.
- Add managed Postgres.
- Add queue/event bus.
- Add private networking.
- Add TLS ingress.
- Add WAF/rate limits.
- Add blue/green or rolling deploys.
- Add rollback strategy.

### 6.17 Testing Gaps

Current state:

- `npm run check` syntax validation.
- `npm run smoke` happy-path integration test.
- No formal unit/integration/contract/e2e/concurrency/failure tests.

Required planning:

- Add test framework.
- Add unit tests for services and shared helpers.
- Add integration tests with test database.
- Add contract tests for every service API.
- Add e2e browser tests.
- Add concurrency tests.
- Add failure-injection tests:
  - accounting down during payment execution
  - reconciliation down during payment execution
  - operations/audit down
  - provider timeout
  - duplicate webhook
  - duplicate idempotency key
  - crash after debit before settlement
- Add migration tests.
- Add ledger invariant tests.
- Add security tests.

### 6.18 Developer Experience

Current state:

- No package dependencies.
- No formatter/linter.
- No typed language.
- No generated docs.

Required planning:

- Add linting and formatting.
- Decide whether to migrate to TypeScript.
- Add dev database bootstrap.
- Add seed scripts.
- Add local env validator.
- Add Makefile or task runner.
- Add pre-commit hooks.
- Add API docs generation.
- Add architecture decision records.

## 7. Suggested Milestone Structure

Fable5 should organize the backlog approximately like this:

### Milestone 0: Prototype Stabilization

Goal: make current prototype safer and testable without redesigning everything.

Include:

- Add formal tests around recent fixes.
- Add request validation.
- Add UI stale-error handling.
- Add direct bug fixes from audit that remain unaddressed.
- Add safer smoke tests that refuse shared/prod URLs.

### Milestone 1: Database Foundation

Goal: replace JSON stores with real schemas and migrations.

Include:

- PostgreSQL.
- Migrations.
- Service-owned schemas.
- Seed data.
- DB constraints.
- Local test DB.

### Milestone 2: Ledger And Payment Safety

Goal: ensure money cannot disappear and balances cannot corrupt.

Include:

- Append-only double-entry ledger.
- Payment state machine.
- Idempotency table.
- Concurrency controls.
- Journal invariants.

### Milestone 3: Async Workflow Foundation

Goal: remove unsafe synchronous multi-service mutation chains.

Include:

- Outbox/inbox.
- Workers.
- Saga orchestration.
- Retry/DLQ.
- Repair operations.

### Milestone 4: Identity, Tenant Isolation, And Approval Controls

Goal: make controls real.

Include:

- Auth.
- RBAC.
- Tenant IDs.
- Four-eyes approval.
- Verified audit actor.
- Cross-tenant tests.

### Milestone 5: Provider And Compliance Integrations

Goal: connect to real-world rails safely.

Include:

- Provider adapter framework.
- AML screening.
- Custody/CASP integration.
- Webhooks.
- ERP/TMS export.
- Secrets manager.

### Milestone 6: Production Operations

Goal: deploy and operate reliably.

Include:

- CI/CD.
- IaC.
- Observability.
- Backups/DR.
- Security scanning.
- Runbooks.

## 8. Non-Negotiable Acceptance Criteria For Production MVP

Fable5 should make sure the final backlog includes tasks that satisfy these:

- No wallet balance is directly mutable outside ledger-posting code.
- Every money movement is append-only and double-entry.
- Every journal batch balances.
- Every payment transition is validated by a state machine.
- Every command is idempotent.
- Concurrent duplicate requests cannot create duplicate effects.
- Every endpoint has authentication and authorization.
- Every row belongs to a tenant.
- Cross-tenant reads and writes are impossible through API and DB policy.
- Every approval records a real approver identity.
- Creator cannot approve own high-risk/high-value payment unless explicitly allowed by policy.
- Every audit event is append-only and tamper-evident.
- Every provider callback is signed, stored, deduped, and replayable.
- Every external side effect is recoverable through outbox/saga processing.
- Every deployment has backup and restore procedures.
- CI blocks merge on tests, lint, migration checks, and security scans.

## 9. Areas Fable5 Should Explicitly Call Out As Out Of Scope Unless Requested

Do not over-plan these unless the user asks:

- Issuing an EMT or ART directly.
- Becoming a regulated CASP directly.
- Full legal/compliance licensing strategy.
- Building a complete ERP product.
- Supporting all chains/assets.
- Native mobile apps.
- AI features.
- Trading/market-making.
- Consumer wallets.

The target product is a corporate treasury control plane that integrates regulated partners, not a bank, exchange, issuer, or consumer wallet by default.

## 10. Final Instruction To Fable5

Read the repo and this brief. Produce a detailed, prioritized engineering task/subtask plan that closes the gaps above. Be concrete. Tie tasks to components and files where possible. Include dependencies and acceptance criteria. Do not hand-wave with "add security" or "use database"; specify the tables, invariants, flows, tests, and operational controls needed.

Be brutally honest about sequencing. If a task depends on identity, tenant model, DB migrations, or ledger foundations, mark that dependency explicitly. The output should be ready for a founder or engineering lead to convert directly into GitHub issues or a Linear/Jira roadmap.
