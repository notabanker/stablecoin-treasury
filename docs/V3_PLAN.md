# V3 Release Plan

Working name: **V3 Secure Pilot Foundation**

Goal: turn the current DB/ledger/outbox/saga prototype into a credible regulated-design-partner pilot foundation. V3 is not "real-money production" yet. It should be strong enough for investor diligence, technical partner review, and sandbox pilots with controlled data and simulated or sandboxed rails.

## Current Baseline

The current build has moved beyond the first static demo:

- PostgreSQL migrations and service-owned schemas exist.
- Wallet ledger safety and DB-backed idempotency exist.
- Payment references and concurrent creation are constraint-backed.
- Payment execution is async through durable jobs.
- Outbox/inbox delivery exists and was patched to avoid pre-publish event loss.
- Repair retry now re-enqueues stuck `Executing` payment jobs.
- The test suite covers unit, integration, and concurrency paths.
- Local stack includes gateway, domain services, relay worker, and job worker.

Remaining critical gap: controls are still not real enough for a pilot. V3 should focus on identity, authorization, tenant isolation, operator repair UX, audit integrity, and first integration scaffolding.

## V3 Release Thesis

V3 should answer these questions convincingly:

1. Who is the user?
2. Which tenant do they belong to?
3. What are they allowed to do?
4. Can they create, approve, execute, repair, and audit treasury actions safely?
5. Can the system survive duplicate requests, worker crashes, service failures, and webhook retries?
6. Can an engineer operate and debug the platform without touching the database manually?

## Non-Goals

Do not include these in V3 unless explicitly requested:

- Direct MiCA licensing implementation.
- Production real-money custody.
- Full ERP/TMS integration.
- Full SAML enterprise rollout.
- Mobile app.
- Multi-region HA.
- Real chain indexer.
- Full provider marketplace.
- Complete DORA/ICT compliance program.

## Release Gates

V3 cannot be called done unless all of these pass:

- `npm run check`
- `npm run test`
- `npm run test:integration`
- `npm run test:concurrency`
- New auth/RBAC tests
- New cross-tenant isolation tests
- New repair/failure-injection tests
- New audit immutability tests
- New UI smoke/e2e test for approval and repair workflows
- No direct DB manual steps required for normal operator repair

## Milestone V3.0: Stabilize Current M3 Foundation

Purpose: make sure the current async foundation is clean, documented, and not carrying silent debt into identity work.

### Task V3.0.1: Update Architecture And Database Docs

Priority: P0

Subtasks:

- [ ] Update `docs/DATABASE.md` to reflect outbox, jobs, payment execution attempts, repair retry, and migration `0017`.
- [ ] Update `docs/ARCHITECTURE.md` with relay/job worker flows.
- [ ] Add a Mermaid diagram for payment execution saga.
- [ ] Document outbox delivery semantics: at-least-once delivery, exactly-once effect through inbox.
- [ ] Document repair retry semantics.

Acceptance criteria:

- [ ] Docs no longer say payment execution is synchronous.
- [ ] Docs no longer say outbox/saga is future-only.
- [ ] New engineer can trace `Approved -> Executing -> job -> ledger -> accounting -> recon -> Settled`.

### Task V3.0.2: Add Failure-Injection Tests For Relay And Jobs

Priority: P0

Subtasks:

- [ ] Test relay crash-before-delivery: outbox row remains unpublished and is later delivered.
- [ ] Test duplicate relay delivery: consumer inbox prevents duplicate effect.
- [ ] Test job worker crash after claim: job becomes recoverable or operator-visible.
- [ ] Test dead-lettered execution job appears in repair API.
- [ ] Test repair retry creates exactly one fresh job.

Acceptance criteria:

- [ ] No outbox event can be permanently lost by process death before delivery.
- [ ] No repair API returns false success when no job exists.
- [ ] Failure tests are part of `npm run test:integration` or a new `npm run test:failure`.

### Task V3.0.3: Tighten Test Stack Reliability

Priority: P1

Subtasks:

- [ ] Improve service startup diagnostics in `tests/helpers/stack.mjs`.
- [ ] Capture child process stderr/stdout when readiness fails.
- [ ] Increase readiness timeout or add service-specific health wait reasons.
- [ ] Add automatic cleanup of orphaned test databases on failure.

Acceptance criteria:

- [ ] A failed test stack reports which service failed and why.
- [ ] No more ambiguous "missing wallet, policy, gateway" flakes without logs.

## Milestone V3.1: Identity And Auth Skeleton

Purpose: replace hardcoded actors with verified users and sessions.

### Task V3.1.1: Identity Schema Expansion

Priority: P0

Subtasks:

- [ ] Add `identity.users`.
- [ ] Add `identity.roles`.
- [ ] Add `identity.permissions`.
- [ ] Add `identity.user_roles`.
- [ ] Add `identity.sessions` or choose stateless JWT in an ADR.
- [ ] Seed demo users:
  - Treasury maker
  - Treasury approver
  - Treasury admin
  - Compliance operator
  - Read-only auditor

Acceptance criteria:

- [ ] Every user belongs to a tenant.
- [ ] Demo seed supports at least two different users with different roles.
- [ ] Migrations are repeatable from an empty DB.

### Task V3.1.2: Gateway Auth Middleware

Priority: P0

Subtasks:

- [ ] Add login endpoint for local/demo auth.
- [ ] Add logout endpoint.
- [ ] Add current-user endpoint.
- [ ] Require auth on all `/api/*` routes except health/docs/login.
- [ ] Attach `{ tenantId, userId, roleIds, permissions }` to gateway request context.
- [ ] Propagate user context to downstream services through signed internal headers or service token.

Acceptance criteria:

- [ ] Anonymous requests to mutating APIs return `401`.
- [ ] Authenticated requests include verified user identity.
- [ ] Hardcoded `"Marta Klein"` is removed from gateway-originated audit events.

### Task V3.1.3: Frontend Login And Session Shell

Priority: P1

Subtasks:

- [ ] Add login view.
- [ ] Add current user display.
- [ ] Add logout action.
- [ ] Show permission-aware navigation.
- [ ] Handle `401` by returning to login.

Acceptance criteria:

- [ ] Browser session can log in as different seeded demo users.
- [ ] UI reflects the active user and role.

## Milestone V3.2: RBAC And Four-Eyes Approval

Purpose: make controls real. A payment control is not real if the same actor can satisfy every step.

### Task V3.2.1: Permission Enforcement

Priority: P0

Required permissions:

```text
payment:create
payment:approve
payment:execute
payment:cancel
payment:repair
wallet:read
policy:read
policy:update
counterparty:read
reconciliation:read
reconciliation:resolve
accounting:read
accounting:export
operations:read
operations:provider:update
audit:read
admin:user:manage
```

Subtasks:

- [ ] Enforce permissions in gateway.
- [ ] Add downstream defense checks for sensitive service endpoints.
- [ ] Add `403` error shape.
- [ ] Add tests for each high-risk permission.

Acceptance criteria:

- [ ] A read-only user cannot mutate anything.
- [ ] A maker can create but not approve own restricted payment.
- [ ] An approver can approve but not change policy.
- [ ] An auditor can read audit but cannot execute payment.

### Task V3.2.2: Real Approval Records

Priority: P0

Subtasks:

- [ ] Use `payment.payment_approvals` as the source of truth.
- [ ] Store `approver_user_id`.
- [ ] Store approval timestamp and request ID.
- [ ] Enforce `UNIQUE(payment_id, approver_user_id)`.
- [ ] Enforce creator cannot approve own payment above configured threshold.
- [ ] Enforce approver has approval permission and limit.
- [ ] Update UI to show approver identities.

Acceptance criteria:

- [ ] Same user cannot approve twice.
- [ ] Creator cannot satisfy four-eyes alone.
- [ ] Approval count is derived from approval rows.
- [ ] Approval history is visible in the UI.

### Task V3.2.3: Execution Authorization

Priority: P0

Subtasks:

- [ ] Require `payment:execute`.
- [ ] Decide whether execute can be automatic after required approvals or manual by an authorized operator.
- [ ] Add ADR for execute policy.
- [ ] Store executor identity or system identity.
- [ ] Audit execution request.

Acceptance criteria:

- [ ] Execution cannot be triggered by an unauthorized user.
- [ ] Execution request identity appears in audit.

## Milestone V3.3: Tenant Isolation

Purpose: prove the platform can safely host more than one organization, even if the pilot starts single-tenant.

### Task V3.3.1: Tenant Context Everywhere

Priority: P0

Subtasks:

- [ ] Stop using only `DEFAULT_TENANT_ID` in request paths.
- [ ] Derive tenant from authenticated user/session.
- [ ] Pass tenant context through gateway and services.
- [ ] Ensure all queries filter by tenant.
- [ ] Ensure all inserts use verified tenant, not client-supplied tenant.

Acceptance criteria:

- [ ] No API accepts arbitrary `tenant_id` from browser input.
- [ ] All service calls use server-derived tenant context.

### Task V3.3.2: Cross-Tenant Test Suite

Priority: P0

Subtasks:

- [ ] Seed two tenants.
- [ ] Seed users for both tenants.
- [ ] Create payments, wallets, counterparties, policies, audit rows for both.
- [ ] Assert tenant A cannot read tenant B state.
- [ ] Assert tenant A cannot mutate tenant B payment by guessing ID.
- [ ] Assert idempotency keys are tenant-scoped.

Acceptance criteria:

- [ ] Cross-tenant read attempts return `404` or `403`.
- [ ] Cross-tenant writes fail.
- [ ] Tests run in CI.

### Task V3.3.3: PostgreSQL RLS Defense Layer

Priority: P1

Subtasks:

- [ ] Add ADR on RLS strategy.
- [ ] Add RLS policies for high-risk tables first:
  - wallets
  - ledger transactions
  - payments
  - approvals
  - journal batches/lines
  - audit events
- [ ] Add transaction helper that sets `app.tenant_id`.
- [ ] Add DB-level tests for RLS.

Acceptance criteria:

- [ ] A query without tenant context cannot read protected rows.
- [ ] A query with wrong tenant context cannot read protected rows.

## Milestone V3.4: Audit Integrity

Purpose: make audit meaningful enough for pilot diligence.

### Task V3.4.1: Verified Audit Actor

Priority: P0

Subtasks:

- [ ] Add `actor_user_id`.
- [ ] Add `actor_type`: `user`, `system`, `service`, `provider`.
- [ ] Add `tenant_id`.
- [ ] Add `request_id`.
- [ ] Add `object_type` and `object_id`.
- [ ] Remove hardcoded person names from audit-producing code.

Acceptance criteria:

- [ ] Every user action audit row links to a real user.
- [ ] Every system action uses a clear system actor.

### Task V3.4.2: Append-Only Audit Enforcement

Priority: P0

Subtasks:

- [ ] Revoke update/delete on audit table for app role.
- [ ] Add DB trigger preventing mutation if necessary.
- [ ] Add audit write API through operations service only.
- [ ] Add tests proving update/delete fail.

Acceptance criteria:

- [ ] Application code cannot mutate or delete audit events.

### Task V3.4.3: Tamper Evidence

Priority: P1

Subtasks:

- [ ] Add canonical JSON hash for audit payload.
- [ ] Add previous hash column per tenant.
- [ ] Add hash chain validation script.
- [ ] Add operator command to verify audit chain.

Acceptance criteria:

- [ ] Any manual tampering breaks verification.
- [ ] Verification can be run in CI against seeded test data.

## Milestone V3.5: Operator Repair UI

Purpose: operators should not need SQL to recover stuck work.

### Task V3.5.1: Repair Queue Screen

Priority: P0

Subtasks:

- [ ] Add `Repair` navigation section.
- [ ] Show stuck `Executing`, `Failed`, and dead-lettered jobs.
- [ ] Show payment reference, status, amount, last error, and attempt history.
- [ ] Add retry action.
- [ ] Add "mark requires manual review" action if retry is unsafe.
- [ ] Add permission gate: `payment:repair`.

Acceptance criteria:

- [ ] A dead-lettered execution job appears in the UI.
- [ ] Authorized operator can enqueue retry from UI.
- [ ] Unauthorized user cannot see or trigger repair.

### Task V3.5.2: Repair Audit And Evidence

Priority: P0

Subtasks:

- [ ] Every repair action writes audit event.
- [ ] Store repair reason/comment.
- [ ] Store actor identity.
- [ ] Link repair event to job ID and payment ID.

Acceptance criteria:

- [ ] Repair history is visible in payment detail.

## Milestone V3.6: Observability And Operations

Purpose: the system should explain itself under failure.

### Task V3.6.1: Metrics

Priority: P1

Subtasks:

- [ ] Add outbox lag metric.
- [ ] Add unpublished outbox count.
- [ ] Add job queue depth by status/type.
- [ ] Add dead-letter count.
- [ ] Add payment state counts.
- [ ] Add saga step failure count.
- [ ] Add reconciliation exception age.

Acceptance criteria:

- [ ] `/metrics` exposes operationally useful counters/gauges.
- [ ] Dashboard document explains what to alert on.

### Task V3.6.2: Structured Logging And Correlation

Priority: P1

Subtasks:

- [ ] Propagate request ID from browser/gateway through service calls, jobs, and relay.
- [ ] Add job ID and event ID to logs.
- [ ] Redact sensitive fields.
- [ ] Add standard log schema.

Acceptance criteria:

- [ ] A payment can be traced from create through settlement using request/payment/job IDs.

### Task V3.6.3: Runbooks

Priority: P1

Subtasks:

- [ ] Write runbook for dead-lettered payment execution.
- [ ] Write runbook for relay backlog.
- [ ] Write runbook for database migration failure.
- [ ] Write runbook for service timeout storm.
- [ ] Write runbook for failed accounting export.

Acceptance criteria:

- [ ] `docs/RUNBOOKS.md` exists and matches actual APIs/commands.

## Milestone V3.7: First Provider Sandbox Skeleton

Purpose: create integration seams without committing to a real regulated partner yet.

### Task V3.7.1: Provider Adapter Interface

Priority: P1

Subtasks:

- [ ] Define adapter interface for custody/settlement.
- [ ] Define result statuses:
  - accepted
  - pending
  - settled
  - failed
  - rejected
- [ ] Add provider request/response persistence.
- [ ] Add provider idempotency key.
- [ ] Add fake sandbox adapter using same interface.

Acceptance criteria:

- [ ] Payment saga calls adapter interface, not hardcoded provider simulation.
- [ ] Fake adapter can simulate success, timeout, rejection, delayed callback.

### Task V3.7.2: Webhook Ingestion Skeleton

Priority: P1

Subtasks:

- [ ] Add webhook endpoint.
- [ ] Store raw webhook event.
- [ ] Verify fake signature for sandbox adapter.
- [ ] Deduplicate by provider event ID.
- [ ] Replay webhook event safely.
- [ ] Route webhook event into saga/reconciliation.

Acceptance criteria:

- [ ] Duplicate webhook does not duplicate effects.
- [ ] Invalid signature is rejected.
- [ ] Webhook replay is operator-triggerable.

## Milestone V3.8: V3 Release Packaging

Purpose: make it presentable and repeatable.

### Task V3.8.1: Demo Scenarios

Priority: P1

Subtasks:

- [ ] Scenario 1: maker creates payment, approver approves, executor executes.
- [ ] Scenario 2: review counterparty blocks approval.
- [ ] Scenario 3: worker failure causes repair queue item, operator retries.
- [ ] Scenario 4: cross-tenant isolation demo.
- [ ] Scenario 5: audit trail verifies actor and action.

Acceptance criteria:

- [ ] Each scenario has seed data and exact demo steps.
- [ ] Each scenario can be reset and replayed.

### Task V3.8.2: Investor/Partner Technical Packet

Priority: P2

Subtasks:

- [ ] Update architecture diagram.
- [ ] Add one-page security model.
- [ ] Add one-page reliability model.
- [ ] Add one-page regulatory architecture assumptions.
- [ ] Add API/endpoint overview.
- [ ] Add known gaps section.

Acceptance criteria:

- [ ] A technical advisor can review V3 without reading every source file.

## Suggested Timeline

Assuming one strong engineer:

| Week | Focus |
| --- | --- |
| 1 | V3.0 stabilization, docs, failure tests |
| 2 | identity schema, local login, auth middleware |
| 3 | RBAC, real approvals, permission-aware UI |
| 4 | tenant propagation, cross-tenant tests, RLS first pass |
| 5 | audit integrity and repair UI |
| 6 | observability, runbooks, provider adapter skeleton |
| 7 | webhook skeleton, release hardening |
| 8 | demo scenarios, investor/partner packet, bug bash |

With two engineers:

- Engineer A: identity/RBAC/tenant/audit.
- Engineer B: repair UI/observability/provider adapter/failure tests.
- Target can compress to 4-5 weeks if scope discipline is strict.

## Cut Line

If time gets tight, V3 must keep:

- Auth
- RBAC
- Real approvals
- Tenant isolation tests
- Repair UI
- Audit actor integrity
- Failure-injection tests

Defer if necessary:

- RLS hardening beyond critical tables
- Tamper-evident hash chain
- Webhook skeleton
- Provider adapter beyond fake sandbox
- Investor packet polish

## Definition Of V3 Done

V3 is done when:

- A demo user can log in.
- A maker can create a payment but cannot self-approve restricted payments.
- A separate approver can approve.
- An authorized executor or system policy can execute.
- A stuck saga appears in a repair queue.
- An operator can retry from the UI.
- Audit rows show real actor identity.
- Cross-tenant access is blocked and tested.
- Outbox/job failures are covered by tests.
- The local stack can be reset, migrated, started, tested, and demoed from docs without manual DB surgery.
