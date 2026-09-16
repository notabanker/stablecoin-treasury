# History

Dated record of audits, releases, and refactor passes. The 2026-09 documentation
consolidation removed the phase/process artifacts that carried this history; their outcomes
are preserved here.

## 2026-07-03 — Prototype era: audit, brief, MVP backlog

- **AUDIT.md (v1):** first whole-codebase audit/pitch-prep brief. Found 5 HIGH and 10 MEDIUM
  issues in the JSON-store prototype (no tests, no DB, no auth, single tenant).
- **FABLE5_GAP_PLANNING_BRIEF.md:** structured input for producing a production-grade MVP
  backlog (aimed at regulated pilots, not day-one enterprise scale).
- **PRODUCTION_MVP_BACKLOG.md:** the resulting M0–M6 plan — test harness, Postgres
  schema-per-service with `tenant_id` from day one, append-only ledger, DB-enforced payment
  state machine, outbox/jobs/saga, identity/RBAC/tenant isolation, provider adapters,
  production operations. Delivered across V5/V6; ADR-001–009 decisions came out of it.

## 2026-07-03/04 — V3/V5 audits and hardening

- **AUDIT_V2/V3/V4:** independent re-audit briefs. v2 verified the v1 fixes; v3 exposed the
  0053 regression (80/88 integration failures from over-tightened grants); v4 confirmed the
  SECURITY DEFINER reset-function fix (0055) and left M1–M8 tracked.
- **AUDIT_REPORT_FABLE5.md:** deep production-readiness/stress audit with live failure
  injection (findings F-1–F-17). Drove the fixes for stuck-`Executing` repayments, inbox
  dedupe, unsalted passwords, rate limiting, spooled state reads, and webhook trust.
- **V3_PLAN.md / V3_TECHNICAL_PACKET.md / V3_DEMO_SCENARIOS.md:** V3 "secure pilot
  foundation" plan — identity/auth skeleton, RBAC, cross-tenant tests, repair surface,
  docs truth pass. Completed.
- **V5_VERIFIED_GAPS_TASK_LIST.md / V5_REMAINING_GAPS_FIX_INSTRUCTION.md:** reproduced
  security gaps (unenforced internal auth, CSRF bypasses, rate-limit buckets, tenant-scoped
  login audit) and their fix instructions.
- **V5_COMPLETION_REPORT.md:** V5 production hardening completed (config gate, secure
  cookies, runbooks/demo script); V5.1 closed the verified gaps with regression coverage.

## 2026-07-04/05 — V6: hardened demo → operable pilot

- **V6_PLAN.md / V6_TASK_LIST.md / V6_EXECUTION_INSTRUCTION.md /
  V6_REMAINING_TASKS_INSTRUCTION.md:** the V6 program definition, checkbox backlog, and
  agent execution prompts (gates A1–A6).
- **V6_COMPLETION_REPORT.md:** all eight epics delivered — real four-eyes approvals with
  verified identity, per-service Postgres roles + RLS on all schemas, SHA-256 audit hash
  chain with nightly verifier and runbook, provider adapter seam + statement ingestion,
  money-path metrics + watchdog, session/edge hardening, Terraform skeleton.
- **V6_AUDIT_REPORT.md:** adversarial audit at 125 green tests. Found H1 (`ALLOW_DEMO_RESET`
  undocumented in code), H2 (cross-tenant demo reset), H3 (outbox poison-event starvation),
  plus M1–M7 (session token in login body, single-tenant jobs, broad grants, untested
  breaker, default DB password, docs contradictions, approvals UI) and L1–L6.
- **LLM_TECHNICAL_HANDOFF_OPEN_FINDINGS.md:** 12 follow-up findings. The CRITICAL one —
  provider submission not crash-safe — was closed by V8 Phase 0. Others (cancel-audit actor,
  job attempt accounting, multi-tenant watchdog, statement tenant scoping, webhook raw-body
  signing, internal-auth header parsing, X-Acting-User) were closed in later passes. Two
  remain open: wallet-ledger request-hash comparison and audit-insert tenant-context restore.
- **V6_JUDGE_INSTRUCTION.md:** blind-verification prompt used to independently grade the
  V6 claims (claim-vs-code, biting tests, docs fidelity).
- **HANDOFF.md:** V8 Phase 0 catch-up document; superseded by `PROJECT_STATE.md`.

## 2026-07-12/15 — V8 Phase 0 and release 0.2.0

- **V8_FINAL_PLAN.md / V8_IMPLEMENTATION_PLAN.md / V8_TASK_LIST.md /
  V8_EXECUTION_INSTRUCTION.md:** the settlement + treasury pivot (SMB → corporate), locked
  decisions (sevdesk, Doppler, Circle sandbox; G1/G2/G4/G5 approved) and gated task IDs.
- Phase 0 delivered: `ALLOW_DEMO_RESET` production gate, tenant-scoped reseeds with
  `admin:reset` guard tests, adversarial production-reset test, outbox attempts/backoff/DLQ,
  watchdog alert, and crash-safe `payment.provider_submissions` (migrations 0050–0052).
- **Release 0.2.0:** V8 Phase 0 committed, RLS + roles + four-eyes + statements +
  credential-rotation docs shipped; session token stripped from the login body in production;
  background jobs iterate all tenants; production gate rejects the default DB password.

## 2026-08-05/09 — Quality remediation and the 2026-08 audit fixes

- **QUALITY_REMEDIATION_INSTRUCTION.md:** Q1–Q12 quality backlog. Q1–Q8 delivered (UUID ids,
  tenant fail-closed, Money adoption, cookie-only browser sessions, web-view split); Q9
  (shared row mappers) and Q12 (rag-system quarantine) landed later with the refactor; Q10
  (lint floor) and Q11 (dual-0017 documentation) remain open.
- **superpowers/plans/2026-08-09-audit-fixes.md:** F0–F13 plan from the whole-codebase
  audit. All complete: working-tree commit, tenant-guarded reset functions, expiry audit,
  read permissions, raw-body webhook signatures, invariants script, money rounding, worker
  hygiene, dead-code removal, doc drift repair, and the adversarial production-reset test.
  Suite at 179 green (79 unit + 96 integration + 4 concurrency).
- **DEMO_SCRIPT_V5.md / docs/AUDIT_ARCHITECTURE.md:** demo walkthrough and the early audit
  outbox design (payment events → outbox → relay → operations `/audit`), both superseded by
  the current architecture docs.

## 2026-09-16 — Simplification pass and release 0.3.0

- **Shared runtime extraction:** `packages/shared/service.mjs` (`createDomainService`) and
  `worker.mjs` (worker health server + poll loop) now own the boilerplate previously
  duplicated in every service and worker.
- **God-file splits:** `payment-service` → `payments.mjs` / `idempotency.mjs` /
  `approvals.mjs`; `accounting-service` → `journals.mjs`; `reconciliation-service` →
  `store.mjs` / `statements.mjs`; `job-worker` → `queue.mjs` / `scheduler.mjs` /
  `active-tenants.mjs` / `handlers/*`; gateway web code stays behind
  `apps/web/js/{state,util,api,views-*}.js` with render helpers in `util.js`.
- **Shared module consolidation:** `payment.mjs`, `policy-math.mjs`, `rows.mjs`,
  `metrics.mjs`, `log.mjs`; demo fixtures moved to `seed-data.json`; dead
  `provider-adapter.mjs` removed.
- **Tests:** integration suite consolidated and split (`auth-rbac` → `auth` + `rbac`;
  shared `tests/helpers/{api,db}.mjs`); concurrency suite unchanged in intent.
- **Docs:** consolidated from ~13,800 lines across 50 files to a small accuracy-first set;
  stale phase/audit artifacts deleted with their outcomes recorded here.

## 2026-09-16 — Independent review of the simplification PR

- **SIMPLIFICATION_HANDOFF.md / docs/REVIEW_FOLLOWUP.md:** review brief for PR #2 and the
  follow-up work order it produced. Both superseded by this entry; the review itself is
  preserved on the pull request.
- **Verified, not taken on trust:** every measured claim in the brief reproduces from the
  branch — the diffstat, `db/migrations` untouched at zero lines, and each row of the LOC
  table. Gated areas were genuinely untouched: `db.mjs`, `outbox.mjs`, `audit.mjs`,
  `jobs.mjs` and `tenant.mjs` differ from the baseline by nothing but un-exports. Test-name
  parity held at 177 names, and the assertion-count delta was fully accounted for.
- **Honest reading of the LOC result:** 89% of the whole-repository reduction is prose.
  Production logic fell ~16%, migrations and test coverage by design not at all.
- **One regression found and fixed:** `GET /api/state` had been made degraded-tolerant with
  no consumer for the `degraded` field, so a downstream outage rendered as an empty desk
  rather than an error. The composer stays unified; the degradation is now visible in the UI
  and pinned by `tests/integration/state-degraded.test.mjs`.
- **Three follow-ups delivered:** `validateSession` un-exported (it had been claimed and not
  done); `docs/ARCHITECTURE.md` corrected — it credited `log.mjs` with redaction it does not
  perform, and still routed new services through `scripts/dev.mjs` / `service-client.mjs`
  after both became derived from `packages/shared/services.mjs`; `table()` in
  `apps/web/js/util.js` now escapes by default like its sibling helpers, with explicit
  `{ html }` / `{ td }` raw hatches, rendered output snapshot-identical.
- **Uncredited wins the review surfaced:** generating `/api/docs` from the route table fixed
  real drift (the hand-maintained list was missing `GET /api/payments/:id/approvals`), and
  `tests/unit/breaker.test.mjs` had been testing an inlined copy of the circuit breaker
  rather than the real one.
