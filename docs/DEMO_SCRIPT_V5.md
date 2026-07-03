# V5 Investor Demo Script (~7 minutes)

**Pre-flight:** `npm run dev` — all 8 services + 2 workers running. Gateway at http://127.0.0.1:8080.

## 1. Login as Vega Admin (30s)
- Open http://127.0.0.1:8080
- Login: `marta@vega-industries.com` / `demo123` (demo only — production uses scrypt-hashed credentials)
- Dashboard shows: wallets (EURC, USDC, EURI), counterparties, recent payments, policy config

## 2. Show Treasury Dashboard (30s)
- Overview panel: entity wallets with balances, provider status, recent alerts
- Note: Vega Industries SE (default tenant) has 3 entities across 3 jurisdictions

## 3. Create Supplier Payment (60s)
- Payments view → "New Payment"
- Fill: amount=25000, counterparty=Nordic Clean Tech (cp-nordic), wallet=Vega Holding EURC, type=Supplier
- Payment appears with status "Pending approval"
- Point out: audit event recorded with actor identity

## 4. Approve Payment (30s)
- Click "Approve" on the pending payment
- Status transitions to "Approved"
- Note: Approval threshold configured at 50000 EUR-equivalent; this payment requires 1 approval

## 5. Execute Payment - Saga in Action (60s)
- Click "Execute"
- Status changes to "Executing" (saga enqueued)
- After ~1-2 seconds, status auto-updates to "Settled"
- Point out: execution attempts are visible via the Attempts view
- Journal shows 3 balanced lines (Cash debit, Supplier Payable credit, Fee revenue credit)

## 6. Show Ledger Impact (30s)
- Wallets view shows updated balance (original - 25000 - fee)
- Accounting view shows journal entries for this payment
- Reconciliation view shows "Matched" row

## 7. Show Audit Trail (30s)
- Operations → Audit view
- Filter by payment reference: created → approved → execution enqueued → settled
- All events show actor identity (no "Marta Klein" hardcodes)

## 8. Show Repair Queue (30s)
- Repair view (empty in normal operation)
- Explain: if a saga fails (service down, timeout), payment goes to Failed/Executing
- Operator clicks "Retry" to enqueue a new saga job

## 9. Tenant Isolation Demo (60s)
- Logout
- Login as: `admin@nordic-holdings.com` / `demo123` (Nordic Holdings AB — tenant 2)
- Dashboard shows Nordic data only (different entities, wallets)
- Try accessing Vega payment by ID — not visible (tenant isolation)

## 10. Show Production Readiness (60s)
- Gateway /metrics endpoint: request counts, status distribution
- Relay worker /metrics: published, failed, noRoute counts
- Job worker /metrics: claimed, completed, failed, deadLettered
- API docs at /api/docs listing all V5 endpoints
- Runbooks at docs/RUNBOOKS.md for every failure mode

## Emergency Demo Reset
`POST /api/reset` (requires admin permission) — restores seed data.
In production mode, reset is disabled unless `ALLOW_DEMO_RESET=true`.
