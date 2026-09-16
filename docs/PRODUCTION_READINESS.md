# Production Readiness

Last updated: 2026-09-16. This document states what is delivered and what is still missing
before real money movement. Every "delivered" claim is backed by a test or probe; nothing
already implemented is listed as missing.

**Production money movement: NO-GO.** The application layer is hardened; real provider
rails, secrets management, and production infrastructure are not in place.

## Delivered Reliability Features

| Area | What is delivered | Proof |
|---|---|---|
| Ledger | Append-only double-entry ledger; balances derived, never mutable; overdraft impossible under concurrency | balance trigger + `FOR UPDATE` debit; concurrency suite; `npm run invariants` |
| Journals | Balanced batches per payment, asserted by deferred trigger; CSV export marks `Ready → Exported` | `accounting-journals.test.mjs`, `payment-lifecycle.test.mjs` |
| Payment lifecycle | DB-enforced state graph + append-only `payment_events`; unique references via sequence | `payment-transitions-db.test.mjs`, concurrency suite |
| Approval governance | Real four-eyes: verified approver identity, creator cannot approve, distinct approvers | `approvals.test.mjs` |
| Async execution | Durable saga via `platform.jobs`; idempotent steps; resumable from `Executing` via repair API | `saga.test.mjs`, `saga-failure.test.mjs`, `payment-lifecycle.test.mjs` |
| Provider crash-safety | Deterministic idempotency key persisted before the external call; accepted-then-failed runs stay repairable, never silently `Failed` | `provider-crash-safety.test.mjs` |
| Outbox/inbox | Transactional outbox, at-least-once relay, per-consumer inbox dedupe; exponential backoff; poison events dead-letter and alert | `saga.test.mjs`, `outbox-dlq.test.mjs` |
| Tenant isolation | App-layer scoping + RLS fail-closed + `WITH CHECK` + per-service roles with cross-schema `REVOKE` | `rls.test.mjs`, `role-isolation.test.mjs`, `auth.test.mjs` |
| Audit integrity | Per-tenant SHA-256 hash chain, advisory-lock serialized, nightly verifier, tamper/relink/gap detection | `audit-chain.test.mjs`, `scripts/verify-audit-chain.mjs` |
| Auth/session | scrypt password hashing, session rotation, idle/absolute TTLs, CSRF for cookie mutations, login rate limit + lockout | `auth.test.mjs`, `rbac.test.mjs` |
| Webhooks | HMAC-SHA256 over raw body bytes, signature-validated, tenant from provider registry, deduped by event id | `webhooks.test.mjs` |
| Production gate | Boot fails on unsafe production config (defaults, localhost DB, missing auth flags, insecure cookies) | `config.test.mjs` |
| Demo reset safety | `PRODUCTION_MODE` gate, tenant-scoped reseeds, SECURITY DEFINER reset functions guarded by tenant context | `prod-reset.test.mjs`, `reset-seed-guard.test.mjs` |
| Observability | `/health`, `/ready`, `/metrics` on every service; money-path metrics (outbox lag, DLQ, stuck payments); watchdog alerts with dedupe; log-hygiene probe | `log-hygiene.test.mjs`, watchdog tests |
| CI | `npm run check`, full test suite, prod-config gate, invariants on GitHub Actions | `.github/workflows/ci.yml` |

## Remaining Application Gaps

- No DB-level `creator ≠ approver` constraint (enforced in application code only).
- Internal HMAC signatures have no timestamp/nonce — no replay freshness window.
- No automated DLQ replay tool for outbox events (documented manual recovery only).
- Wallet-ledger idempotency does not compare request bodies (payment path uses
  deterministic keys, so exposure is limited to direct wallet API callers).
- Audit insert sets the transaction tenant context without restoring it afterward.
- Audit-chain truncation (deleting newest rows) is not detectable without WORM anchoring.
- OIDC/SSO not implemented (ADR-011 defers it unless a partner mandates SSO).
- Rate limiters are per-process in-memory — single-instance pilot only (ADR-010).
- Statement ingestion/matches have no UI exposure; provider settlement webhooks drive the
  saga but no real rail is connected.
- Provider screening is simulated; compliance-service returns seeded status.

## Remaining Provider And Product Gaps

- No real custody/fiat rail: the simulator is the only adapter; Circle sandbox/Fireblocks
  remain external dependencies. Journal sync to an ERP (sevdesk) is not started.
- No fiat accounts, FX, or liquidity features; Phase 1+ product work is gated and parked
  (see [TECHNICAL_TASKS.md](../TECHNICAL_TASKS.md)).

## Infrastructure Gaps (Human-Executed)

Tracked in [TECHNICAL_TASKS.md](../TECHNICAL_TASKS.md) § Infrastructure. Nothing below has
started; the `infra/` Terraform tree is a skeleton with no state and no credentials.

- Secrets manager (Doppler selected for dev/pilot; production vendor TBD).
- Managed PostgreSQL with PITR, backups, and an executed restore drill.
- WAF/DDoS protection and TLS-terminating ingress.
- mTLS or private networking between services.
- Centralized logs, metrics, alert routing, and on-call.
- Environment promotion pipeline (dev → staging → production) and rollback rehearsal.
- Container image signing/attestation; `SERVICE_DB_PASSWORD` rotated off the dev default.
- Penetration test and DORA/MiCA operational runbooks.

## Legal And Compliance

- DORA/ICT risk assessment; jurisdictional review of chosen partners.
- PSP/CASP licensing as applicable (the project currently acts as a software layer over a
  licensed-partner model; no licensing claim is made).
- User acceptance and operational readiness testing with a treasury team.

## Verification Commands

```bash
npm run check
npm run test:all
npm run invariants
npm run smoke          # against a live local stack; resets demo data
node scripts/verify-audit-chain.mjs
```

## Readiness Definitions

- **Demo:** GO — full payment lifecycle, four-eyes, replay-safe async execution, audit chain.
- **Investor/technical diligence:** GO with caveats — controls above are test-backed; the
  gaps in this document must be disclosed.
- **Production money movement:** NO-GO until the application gaps above are closed and the
  infrastructure items are executed and verified.
