# V8 Task List — Settlement + Treasury Service

Companion to `docs/V8_IMPLEMENTATION_PLAN.md`. Task IDs are stable; dependencies reference them explicitly.

**Status:** All tasks **blocked** until Phase 0 begins with explicit human authorization to proceed past V6 close-out.

## Approval gates

| Gate | Scope | Blocks |
|---|---|---|
| G1 | Provider submission table + payment status semantics | 0.3.*, 1.1.*, 1.7.1 |
| G2 | Tenant tier + feature flags | 1.2.* |
| G3 | Fiat accounts + unified ledger | 2.2.* |
| G4 | Integrations schema + ERP OAuth | 1.5.*, 2.3.* |
| G5 | Tiered KYC/AML workflows | 1.3.*, 3.1.2 |
| G6 | API keys + machine auth | 1.6.* |
| G7 | Fiat rail adapter contract | 2.1.* |
| G8 | Liquidity/yield features | 3.2.* |
| G9 | Multi-jurisdiction + residency | 3.1.* |
| G10 | Embedded / white-label tenant model | 3.4.* |

## Definition of done

- Matches `docs/V8_IMPLEMENTATION_PLAN.md` §15.1
- `PROJECT_STATE.md` updated after each epic slice lands

---

## Phase 0 — Money-path safety

### Epic 0.1 — Demo reset safety

- [x] **0.1.1** — `ALLOW_DEMO_RESET` gate on `POST /api/reset` (P0)
- [x] **0.1.2** — Tenant-scoped reseeds (P0)
- [x] **0.1.3** — `admin:reset` scope fix (P0) — kept on tenant Admin (approved 2026-07-12); formalized with regression coverage, no permission change
- [ ] **0.1.4** — Adversarial production reset test (P0) — BLOCKED, see PROJECT_STATE.md session log for the exact unblocker options

### Epic 0.2 — Outbox reliability

- [x] **0.2.1** — Outbox attempts + DLQ columns migration (P0) — 0050 (attempts/last_error/dead_lettered_at) + 0051 (next_attempt_at)
- [x] **0.2.2** — `recordDeliveryAttempt` with backoff (P0) — exponential backoff mirroring platform.jobs (250ms base, doubling, capped 60s)
- [x] **0.2.3** — Watchdog DLQ alert (P0) — "Outbox dead-letter queue non-empty" check added to job-worker runWatchdog
- [x] **0.2.4** — Batch select skips dead-lettered rows (P0) — getUnpublishedEvents excludes dead_lettered_at IS NOT NULL and unelapsed next_attempt_at
- [x] **0.2.5** — Poison + good events delivery test (P0) — tests/integration/outbox-dlq.test.mjs, 2 tests
- [ ] **0.2.6** — DLQ replay tool (P1) — deferred, not required for Phase 0 exit

### Epic 0.3 — Provider crash-safety (Gate G1)

- [x] **0.3.1** — `provider_submissions` schema (P0, G1) — migration 0052, RLS + explicit svc_payment/svc_job grants, ON DELETE CASCADE
- [x] **0.3.2** — Deterministic idempotency key (P0, G1) — `payment:<paymentId>`, stable across retries
- [x] **0.3.3** — Persist pending before external call (P0, G1) — `ensureProviderSubmission` inserts before `adapter.submitTransfer`
- [x] **0.3.4** — Retry via status lookup, not blind resubmit (P0, G1) — reuses recorded provider_ref when status='submitted'; otherwise resubmits with the SAME idempotency key (relies on provider-side idempotency, matches real rail contracts)
- [x] **0.3.5** — Divergent state repair path (P0, G1) — ledger_debit failure after provider success no longer marks Failed; stays Executing, visible on GET /api/repair
- [x] **0.3.6** — Crash-injection integration test (P0, G1) — tests/integration/provider-crash-safety.test.mjs, 2 tests

### Epic 0.4 — Config, auth, integrity

- [ ] **0.4.1** — `SERVICE_DB_PASSWORD` prod gate (P0)
- [ ] **0.4.2** — DB creator≠approver constraint (P0)
- [ ] **0.4.3** — Remove token from login JSON (P1)
- [ ] **0.4.4** — Multi-tenant watchdog + expiry (P1)
- [ ] **0.4.5** — Circuit breaker tests (P1)
- [ ] **0.4.6** — Internal HMAC freshness (P1)
- [ ] **0.4.7** — Delete dead `provider-adapter.mjs` (P2)
- [ ] **0.4.8** — Strengthen saga-failure tests (P2)
- [ ] **0.4.9** — Tighten per-table GRANTs (P2)
- [ ] **0.4.10** — Approvals UI (M7) (P2)

### Epic 0.5 — Documentation

- [ ] **0.5.1** — Reconcile `PRODUCTION_READINESS.md` (P0)
- [ ] **0.5.2** — Update `PROJECT_STATE.md` for V8 (P1)
- [ ] **0.5.3** — Phase 0 completion report template (P2)

**Phase 0 exit:** All P0 tasks checked + verification bundle §15.2

---

## Phase 1 — Settlement MVP + SMB + integrations

### Epic 1.1 — Sandbox rail (5.3)

- [ ] **1.1.1** — Partner + adapter ADR (P0, E1)
- [ ] **1.1.2** — `SandboxCustodyAdapter` (P0, E2)
- [ ] **1.1.3** — Provider row seed (P0)
- [ ] **1.1.4** — Settlement webhook → saga (P0)
- [ ] **1.1.5** — Rail selector UI/API (P1)
- [ ] **1.1.6** — E2E sandbox settlement test (P0)
- [ ] **1.1.7** — Sandbox runbook (P1)

### Epic 1.2 — Tiered product (Gate G2)

- [ ] **1.2.1** — `tenants.tier` + `feature_flags` (P0, G2)
- [ ] **1.2.2** — Gateway tier in `/api/state` (P0, G2)
- [ ] **1.2.3** — Feature flag route enforcement (P0, G2)
- [ ] **1.2.4** — SMB navigation shell (P0, G2)
- [ ] **1.2.5** — SMB dashboard (P0, G2)
- [ ] **1.2.6** — Mobile-responsive SMB (P1, G2)
- [ ] **1.2.7** — Corporate desk preserved (P1, G2)
- [ ] **1.2.8** — SMB demo tenant seed (P1, G2)

### Epic 1.3 — SMB onboarding (Gate G5)

- [ ] **1.3.1** — Onboarding state machine (P0, G5)
- [ ] **1.3.2** — Self-serve signup (P0, G5)
- [ ] **1.3.3** — Light KYC integration (P0, G5)
- [ ] **1.3.4** — Block execute until active (P0, G5)
- [ ] **1.3.5** — In-app education (P1)
- [ ] **1.3.6** — Corporate assisted checklist (P2, G5)

### Epic 1.4 — Templates & recurring

- [ ] **1.4.1** — `payment_templates` schema (P1)
- [ ] **1.4.2** — Template CRUD API + UI (P1)
- [ ] **1.4.3** — Scheduled template materialization (P1)
- [ ] **1.4.4** — Vendor payout batch (P2, G2)

### Epic 1.5 — Accounting connector (Gate G4)

- [ ] **1.5.1** — Integration ADR (P0, G4)
- [ ] **1.5.2** — `integrations` schema (P0, G4)
- [ ] **1.5.3** — OAuth connect UI (P0, G4, E4)
- [ ] **1.5.4** — Journal mapper (P0, G4)
- [ ] **1.5.5** — Sync job on settle/export (P0, G4)
- [ ] **1.5.6** — Fixture-based integration tests (P0, G4)
- [ ] **1.5.7** — GL mapping UI (P1, G4)

### Epic 1.6 — API & webhooks (Gate G6)

- [ ] **1.6.1** — API keys (P1, G6)
- [ ] **1.6.2** — OpenAPI docs (P1)
- [ ] **1.6.3** — Outbound tenant webhooks (P1)
- [ ] **1.6.4** — Callback signing (P1, G6)
- [ ] **1.6.5** — API key rate limits (P2, G6)

### Epic 1.7 — Settlement visibility

- [ ] **1.7.1** — `settlement_instructions` log (P1, G1)
- [ ] **1.7.2** — Payment detail timeline (P1)
- [ ] **1.7.3** — SMB activity feed (P1)
- [ ] **1.7.4** — Statement list UI (P1)

**Phase 1 exit:** 1.1.6 + 1.2.5 + 1.5.6 + Phase 0 still green

---

## Phase 2 — Fiat + corporate depth

### Epic 2.1 — Fiat rails (Gate G7)

- [ ] **2.1.1** — `fiat-rail.mjs` interface (P0, G7)
- [ ] **2.1.2** — `providers.rail_type` (P0, G7)
- [ ] **2.1.3** — SEPA partner adapter (P0, G7, E3)
- [ ] **2.1.4** — Saga fiat branch (P0, G7)
- [ ] **2.1.5** — Fiat webhooks (P0, G7)
- [ ] **2.1.6** — Fee + ETA disclosure (P1)

### Epic 2.2 — Unified ledger (Gate G3)

- [ ] **2.2.1** — `fiat_accounts` (P0, G3)
- [ ] **2.2.2** — Payment funding source (P0, G3)
- [ ] **2.2.3** — Unified balance API (P0, G3)
- [ ] **2.2.4** — On-ramp flow (P1, G3)
- [ ] **2.2.5** — Off-ramp flow (P1, G3)
- [ ] **2.2.6** — Fiat recon extension (P1)

### Epic 2.3 — Corporate ERP

- [ ] **2.3.1** — MT940 / camt.053 ingest (P0)
- [ ] **2.3.2** — Virtual sub-accounts (P1, G3)
- [ ] **2.3.3** — Second accounting connector (P1, G4)
- [ ] **2.3.4** — SAP export stub (P2, G4)
- [ ] **2.3.5** — COA import (P2, G4)

### Epic 2.4 — Forecasting

- [ ] **2.4.1** — `scheduled_flows` (P1)
- [ ] **2.4.2** — 30/60/90 projection API (P1)
- [ ] **2.4.3** — Forecast UI tiers (P1, G2)
- [ ] **2.4.4** — Shortfall alerts (P2)

### Epic 2.5 — Multi-entity

- [ ] **2.5.1** — Entity hierarchy (P1)
- [ ] **2.5.2** — Consolidated view (P1)
- [ ] **2.5.3** — Policy inheritance (P1)
- [ ] **2.5.4** — Intercompany journal labels (P1)

### Epic 2.6 — Infra wave 1

- [ ] **2.6.1** — Secrets manager (P0, E2)
- [ ] **2.6.2** — Staging IaC (P1)
- [ ] **2.6.3** — Observability dashboards (P1)
- [ ] **2.6.4** — SBOM + SCA in CI (P1)
- [ ] **2.6.5** — Container hardening (P1)

**Phase 2 exit:** 2.1.3 sandbox + 2.2.3 + 2.3.1 demonstrated

---

## Phase 3 — Scale + embed

### Epic 3.1 — Multi-jurisdiction (Gates G5, G9)

- [ ] **3.1.1** — Jurisdiction profile (P0, G9)
- [ ] **3.1.2** — Tiered AML workflows (P0, G5, G9)
- [ ] **3.1.3** — Real-time re-screen (P1)
- [ ] **3.1.4** — Regulatory export packs (P1, G9)
- [ ] **3.1.5** — Data residency flag (P2, G9)

### Epic 3.2 — Liquidity (Gate G8)

- [ ] **3.2.1** — Sweep rules (P1, G8)
- [ ] **3.2.2** — Auto-conversion (P1, G8)
- [ ] **3.2.3** — Compliant yield partner (P2, G8)
- [ ] **3.2.4** — Exposure dashboard (P1)

### Epic 3.3 — Advanced settlement

- [ ] **3.3.1** — Conditional payments (P2, G1)
- [ ] **3.3.2** — Cross-border routing (P1, G7)
- [ ] **3.3.3** — Optional `settlement-service` ADR (P2)
- [ ] **3.3.4** — Message bus evaluation (P2)

### Epic 3.4 — Embedded (Gate G10)

- [ ] **3.4.1** — Embedded tenant tier (P0, G10)
- [ ] **3.4.2** — Partner sub-tenant API (P1, G10)
- [ ] **3.4.3** — Usage metering (P1)
- [ ] **3.4.4** — GraphQL read API (P2)

### Epic 3.5 — Production GO

- [ ] **3.5.1** — Pen test + remediation (P0)
- [ ] **3.5.2** — DORA/MiCA ops runbooks (P0)
- [ ] **3.5.3** — Production GO sign-off checklist (P0)

**Phase 3 exit:** 3.5.3 signed by Flo + legal

---

## External dependencies (not code tasks)

- [ ] **E1** — Custody sandbox partner selected
- [ ] **E2** — Secrets manager vendor live
- [ ] **E3** — EMI/fiat partner contracted
- [ ] **E4** — Xero/QBO developer apps approved
- [ ] **E5** — Licensing strategy memo published
- [ ] **E6** — Pen test scheduled
