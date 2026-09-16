# Technical Backlog

Technology work only; excludes fundraising, sales, legal, licensing, and partner negotiations.
Completed programs are recorded in one line each; outcomes and detailed history are in
[docs/HISTORY.md](docs/HISTORY.md).

## Completed Programs

- **V3 secure-pilot foundation** (2026-07): identity/auth skeleton, RBAC, tenant columns,
  repair surface, docs truth pass.
- **V5 production hardening + V5.1** (2026-07): production config gate, rate limiting,
  login lockout, CSRF/session hardening, internal HMAC auth, runbooks/demo script.
- **V6 pilot hardening** (2026-07): real four-eyes approvals, per-service DB roles + RLS,
  tamper-evident audit chain + nightly verifier, provider adapter seam, statement
  ingestion, money-path metrics + watchdog, CI proven in GitHub Actions.
- **V8 Phase 0 money-path safety** (2026-07/08): demo-reset production gate + tenant scoping,
  outbox dead-letter/backoff, crash-safe `provider_submissions`, config hardening.
- **2026-08-09 audit fixes F0–F13** (2026-08): reset-function tenant guard, expiry audit,
  read permissions, raw-body webhook signatures, invariants script, money rounding, dead
  code removal, doc drift repair.

## Money-Path Safety (open)

- [ ] DB backstop: `creator ≠ approver` constraint on `payment.payment_approvals` (P0)
- [ ] Internal HMAC replay protection: signed timestamp/nonce, reject stale requests (P1)
- [ ] Outbox DLQ replay tool for dead-lettered events (P1; manual runbook step exists)
- [ ] Wallet-ledger idempotency: store request hash; same key + different body → 409 (P2)
- [ ] Audit insert must restore the caller's prior transaction tenant context (P2)
- [ ] Strengthen saga-failure coverage (provider timeout/death matrix, crash-after-debit) (P2)

## Reliability And Observability

- [ ] Audit-chain truncation detection via WORM/external anchoring (P2)
- [ ] Read-path load: coalesce/cache `/api/state` fan-out under concurrency (P2)
- [ ] Tracing beyond request IDs (OpenTelemetry or equivalent) (P3)
- [ ] Statement list UI/gateway exposure for operators (P2)

## Code Quality

- [ ] Lint floor (Biome/ESLint): unused imports, empty catch, eqeqeq (P3)
- [ ] Validate `payment.type` against an allowlist (free string today) (P3)

## Phase 1 Product Work (gated — do not start without approval)

Approved gates: G1 (provider_submissions), G2 (tier/flags), G4 (integrations/sevdesk),
G5 (SMB onboarding). Pending gates: G3 (fiat accounts), G6 (API keys), G7 (fiat rail),
G8 (liquidity/yield), G9 (multi-jurisdiction), G10 (embedded/white-label).

- [ ] Real custody sandbox rail (Circle; Fireblocks alternative) — blocked on E1/E2
- [ ] SMB tier + feature flags + navigation shell/dashboard (G2)
- [ ] SMB onboarding state machine + light KYC (G5)
- [ ] sevdesk connector: integrations schema, OAuth, journal mapper, sync-on-settle (G4)
- [ ] Payment templates and recurring payouts
- [ ] API keys/machine auth, outbound tenant webhooks, OpenAPI docs (G6 pending)
- [ ] Settlement visibility: payment detail timeline, SMB activity feed, statements UI

## Phases 2–3 (parked)

- [ ] Fiat rails + unified fiat/stablecoin ledger (G7/G3)
- [ ] MT940/camt.053 ingest, corporate ERP connector #2, forecasting, entity consolidation
- [ ] Multi-jurisdiction/AML depth, liquidity/yield, embedded/white-label (G8–G10)
- [ ] Pen test, DORA/MiCA ops runbooks, production GO sign-off

## Infrastructure (human-executed)

- [ ] Secrets manager in use (Doppler chosen for dev/pilot; production vendor TBD)
- [ ] Managed Postgres with PITR + executed restore drill
- [ ] WAF/DDoS protection and TLS ingress
- [ ] mTLS or private networking between services
- [ ] Centralized logs/metrics/alert routing and on-call rotation
- [ ] Staging environment + promotion pipeline
- [ ] IaC provisioning (`infra/` Terraform skeleton exists; nothing applied)
- [ ] Rotate `SERVICE_DB_PASSWORD` off the dev default in every non-local environment

## External Dependencies (not code)

- [ ] E1 custody sandbox partner selected · [ ] E2 secrets manager live
- [ ] E3 EMI/fiat partner contracted · [ ] E4 accounting dev apps approved
- [ ] E5 licensing strategy memo · [ ] E6 pen test scheduled
