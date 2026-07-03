# V3 Technical Packet

## Architecture

8 microservices + 2 background workers — one database, schema-per-service:

```
                 ┌──────────┐
                 │  Browser │
                 └────┬─────┘
                      │ HTTP
                 ┌────▼─────┐
                 │ Gateway  │ :8080 (BFF + static files)
                 └────┬─────┘
          ┌───────────┼───────────┬──────────┐
    ┌─────▼────┐ ┌───▼────┐ ┌───▼────┐ ┌──▼──────┐
    │ Payment  │ │Wallet │ │Policy  │ │Compliance│
    │ :4104    │ │ :4101 │ │ :4102  │ │ :4103    │
    └──────────┘ └───────┘ └────────┘ └──────────┘
     ┌─────▼────┐ ┌───▼────┐ ┌───▼────┐
     │Accounting│ │Recon   │ │Ops     │
     │ :4105    │ │ :4106  │ │ :4107  │
     └──────────┘ └────────┘ └────────┘
  ┌────▼────┐  ┌────▼────┐
  │  Relay  │  │  Job    │  (background workers)
  │  :9101  │  │  Worker │
  └─────────┘  │  :9102  │
               └─────────┘
```

All services share one PostgreSQL database with schemas: `identity`, `wallet`, `policy`, `compliance`, `payment`, `accounting`, `reconciliation`, `operations`, `platform`.

## Security Model

1. **Authentication**: Session-based login (cookie or Bearer token). SHA-256 password hashing. Configurable enforcement via `AUTH_REQUIRED` env var (off for development, on for production).
2. **Authorization**: Role-based access control. Roles: Admin, TreasuryAdmin, TreasuryOperator, Approver, ComplianceOps, Auditor. Permissions: `payment:create`, `payment:approve`, `payment:execute`, `payment:cancel`, `payment:view`, `policy:update`, `reconciliation:resolve`, `accounting:export`, `admin:reset`, `admin:manage_users`, `audit:view`.
3. **Tenant isolation**: All tables carry `tenant_id` column with FK to `identity.tenants`. Cross-tenant access prevented at the application layer. Row-Level Security planned for M4.
4. **Audit tamper evidence**: `REVOKE UPDATE, DELETE` on `operations.audit_events`. All state changes emit outbox events. Hash chain planned for M4.
5. **Internal service auth**: Planned for M4. Currently internal endpoints accept unauthenticated calls.

## Reliability Model

1. **Transactional outbox**: Every side effect (audit, alert, exception) shares its write transaction with the triggering state change. Relay worker delivers at-least-once.
2. **Durable job queue**: Payment execution saga runs asynchronously via `platform.jobs`. Each attempt logged. Dead-letter queue for exhausted retries.
3. **Idempotency**: All saga steps (ledger debit, journal creation, reconciliation) are idempotent by key or unique constraint. Duplicate effects impossible at DB level.
4. **Saga compensation**: Failed payment execution transitions to `Failed` status. Operator repair endpoint enqueues a new saga job. Future: automatic compensation via reversing ledger transactions.
5. **Payment state machine**: DB trigger enforces the transition graph. Invalid transitions rejected at commit. Full history in `payment.payment_events`.
6. **Double-entry ledger**: Every balance movement is two or more entries that must sum to zero. Deferred constraint trigger enforces at commit.

## Regulatory Architecture (MiCA Alignment)

- **Custody segregation**: Wallet balances derived from append-only ledger entries, not mutable columns. Each legal entity's wallets tracked separately.
- **Screening**: Counterparty screening at payment creation. Blocked counterparties rejected outright. Under-review counterparties gate approval.
- **Policy framework**: Configurable approval thresholds (EUR-converted), hard transfer limits, concentration limits, asset/provider allowlists. Policy decisions logged immutably.
- **Audit trail**: Every payment state change, policy decision, and operator action recorded with timestamp and actor identity.
- **Reconciliation**: Matched rows for every settled payment. Exception lifecycle (Open → Investigating → Resolved). Age-based SLA tracking.

## API Overview

| Endpoint | Auth | Permission |
|---|---|---|
| `POST /api/login` | No | - |
| `POST /api/logout` | Yes | - |
| `GET /api/state` | Optional | - |
| `POST /api/payments` | Yes | `payment:create` |
| `POST /api/payments/:id/approve` | Yes | `payment:approve` |
| `POST /api/payments/:id/execute` | Yes | `payment:execute` |
| `POST /api/payments/:id/cancel` | Yes | `payment:cancel` |
| `POST /api/policies` | Yes | `policy:update` |
| `POST /api/reconciliation/:id/resolve` | Yes | `reconciliation:resolve` |
| `POST /api/accounting/export` | Yes | `accounting:export` |
| `GET /api/repair` | Yes | - |
| `POST /api/repair/:id/retry` | Yes | - |
| `POST /api/webhooks/:providerId` | No* | - |

*Webhook endpoints use HMAC signature verification.

## Known Gaps

- No real provider integrations (simulated adapters only)
- No tamper-evident hash chain on audit events
- No OpenTelemetry SDK (request-id based tracing only)
- No CI/CD pipeline configuration
- No production secrets management
- No rate limiting or WAF
- Single tenant in practice (tenant_id columns exist, cross-tenant tests exist, but only one tenant has data)
- Internal service-to-service auth not yet enforced
