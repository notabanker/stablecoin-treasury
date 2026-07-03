# V3 Demo Scenarios

All scenarios assume the stack is running (`npm run dev`). Gateway: http://127.0.0.1:8080.

## Scenario 1: Maker Creates Payment, Approver Approves, Executor Executes

Seed data users:
- `marta@vega-industries.com` (Admin — all permissions)
- `approver@vega-industries.com` (Approver — can approve only)
- Password for both: `demo123`

Steps (using Admin session):
1. `POST /api/login` with `{ email: "marta@vega-industries.com", password: "demo123" }`
2. Save the session token from the response
3. `POST /api/payments` with `{ amount: 25000, counterpartyId: "cp-nordic", sourceWalletId: "wal-hold-eur", type: "Supplier" }` — creates payment in "Pending approval" status
4. `POST /api/payments/:id/approve` — transitions to "Approved"
5. `POST /api/payments/:id/execute` — transitions to "Executing", enqueues saga
6. Poll `GET /api/state` until payment is "Settled" (saga completes automatically)
7. Verify journal has 3 balanced lines, reconciliation has 1 matched row

## Scenario 2: Blocked Counterparty

1. `POST /api/payments` with `{ amount: 1000, counterpartyId: "cp-baltic", sourceWalletId: "wal-de-eur", type: "Supplier" }`
2. Response: payment.status = "Blocked"
3. Reason: counterparty cp-baltic is blocked by compliance screening

## Scenario 3: Worker Failure Causes Repair Queue Item

1. Kill the job worker process: `kill <job-worker-pid>`
2. Create, approve, and execute a payment
3. Payment stays "Executing" (saga never runs)
4. Restart the job worker
5. Call `POST /api/repair/:id/retry` to enqueue a new saga job
6. Verify the saga eventually settles

## Scenario 4: Cross-Tenant Isolation

1. Login as `admin@nordic-holdings.com` (tenant 2 user)
2. Access `GET /api/state` — should only see tenant 2 data
3. Try to access tenant 1 payment data — should be blocked

## Scenario 5: Audit Trail

1. Create, approve, and execute a payment
2. `GET /api/state` — check `audit` array for events with actor, action, object, detail
3. All audit events should show the actor's display name (no "Marta Klein" hardcoded strings)
4. Verify audit rows match the payment lifecycle: created → approved → execution enqueued → settled

## Resetting for Replay

`POST /api/reset` — restores seed data. All scenarios can be replayed.
