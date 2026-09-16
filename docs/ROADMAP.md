# Roadmap: First Paying Customer

Commercial plan through the first paying customer. Technical work items referenced here live in
[TECHNICAL_TASKS.md](TECHNICAL_TASKS.md); current engineering state is in
[PROJECT_STATE.md](PROJECT_STATE.md).

**Status: development-stage. Production money movement is NO-GO** until the partner bank and
the production gates in this document exist. No date in this file is a commitment; phases are
ordered and gated.

## Strategic premise

No MiCA license and no custody license, and Germany is a brutal jurisdiction to obtain either.
Therefore: **work with a licensed bank as the regulated anchor**. Two viable structures:

| | A — Agent of the bank/CASP | B — Software vendor to the bank (outsourcing) |
|---|---|---|
| You sell | The platform to corporate customers | The platform to the bank, bank sells onward |
| Regulated duties | Bank keeps custody/settlement/KYC | Bank keeps everything; you inherit MaRisk AT 9 / DORA obligations (audit, BCP, exit management) |
| Time to revenue | Fast | Slow |
| Margin / scale | Low / capped by partner pricing | Higher / scalable |
| Risk | Partner dependency | Long sales cycle, heavy compliance burden |

**Decision: start as A, negotiate the contract so B stays possible later** (no exclusivity on
the software layer, clear IP, change-of-control/exit clause).

## Phases

### Phase 0 — Validation (weeks 1–4)

- Interview 10–20 treasury teams; ICP: €50–500m revenue, EUR-centric, DACH first.
- Bank shortlist: B2B banks with EMT custody / tokenized deposits / CASP subsidiaries.
- Pick one lead partner; decide structure A vs. B; draft pricing (platform fee + volume basis
  points).
- **Gate:** 3+ letters of intent from design partners; 1 bank term sheet in reach.

### Phase 1 — Partner contract + compliance skeleton (months 2–4)

- Contract: agent or outsourcing agreement, DPA/GDPR, KYB delegation to the bank.
- Screening: contract a provider (TRM/Chainalysis class) and implement it behind the existing
  `compliance-service` seam.
- Bank API mapping onto the custody-adapter seam (`packages/shared/adapters/custody.mjs`);
  sandbox access is enough.
- SSO/SCIM for enterprise login (ADR-011); fix EU hosting location.
- **Gate:** signed partner contract; data-protection setup reviewed by counsel.

### Phase 2 — Rails integration + hardening (months 4–7)

- Real bank adapter: `submitTransfer` / `getTransferStatus` / `getBalances`, sandbox → test
  environment.
- Settlement webhooks and statement matching already exist
  (`process-settlement-webhook`, statement matcher); adapt them to the bank's formats
  (MT940/camt.053).
- Accounting export in **DATEV/SAP format** (a DACH requirement, not optional).
- Production foundations: managed Postgres + PITR, secrets manager, WAF, backup/restore
  runbooks, penetration test. See "Infrastructure (human-executed)" in TECHNICAL_TASKS.md.
- **Gate:** end-to-end settlement with real test funds through the bank; pen test findings
  closed.

### Phase 3 — Paid pilot (months 7–9)

- 3–5 design partners on real, small amounts at a heavily reduced pilot price.
- Onboarding/support runbook, incident process, KYC flow via the bank.
- Sell the audit chain, four-eyes and reconciliation story — it is real and differentiated.
- **Gate:** 3 paying pilots, 30 days of clean operation, per-customer churn risk understood.

### Phase 4 — First full-price customer / early GA (months 9–12)

- Full contract, onboarding, go-live with real volume.
- Finalize pricing; minimal support/ops staffing.
- **Gate:** 1 customer at full price with ongoing volume = **first paying customer**.

## What the code already provides vs. what is missing

| Already solid | Missing |
|---|---|
| Custody-adapter seam for real bank APIs | Real adapter implementations |
| Webhook settlement + provider-statement matching | Bank file formats (MT940/camt.053) |
| Four-eyes approvals, idempotency, crash-safe submissions, audit hash chain, RLS tenants | SSO/SCIM, DATEV/SAP export |
| Durable jobs/outbox, invariant + concurrency test suites | KYC/screening integration, production infra/security |

## Explicitly out of scope

- Applying for a MiCA/custody license (years, millions, not viable as the first move).
- Building own blockchain/custody infrastructure — the bank brings the rails.
- Feature depth ahead of partner integration: the next feature after the bank adapter is
  whatever the design partners demand.

## Cadence

Revisit this document after each gate. Every phase has a hard exit: if the gate fails, stop,
re-plan with the evidence, do not drift into building more product.
