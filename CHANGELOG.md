# Changelog

## 0.2.0 (2026-07-15)

### Added
- V8 Phase 0: crash safety, outbox DLQ, tenant resets, multi-tenant jobs
- Tamper-evident audit hash chain with nightly verifier and alert lifecycle
- Row-level security (RLS) on all tenant-scoped tables across every schema
- Per-service Postgres roles with cross-schema REVOKE isolation
- Real four-eyes approvals with verified approver identity, creator-cannot-approve, and distinct approvers
- Provider statement ingestion and matching (V6 Epic 5.2)
- Circuit breaker provider adapter interface
- Idempotency-key enforcement (400 on missing key instead of silent randomUUID fallback)
- Credential rotation documentation (`docs/CREDENTIAL_ROTATION.md`)
- Second user for tenant 2 (Maria Schmidt) enabling four-eyes demo
- Production boot gate validation on all services
- Webhook signing and verification
- Rate limiting and brute-force login lockout

### Changed
- All services: production config validation on startup
- Documentation refreshed: ARCHITECTURE.md (10 services, 2 tenants, RLS/audit-chain sections), PRODUCTION_READINESS.md (151 tests)

### Fixed
- H1: V8 Phase 0 work committed (0050-0053 migrations, crash-safety, DLQ)
- H2: Session token stripped from login response body in production mode
- H3: Background jobs now iterate all tenants instead of hardcoding DEFAULT_TENANT_ID
- H4: Production gate validates SERVICE_DB_PASSWORD is not default
- H5: Blanket grants tightened — audit/log tables are append-only

## 0.1.0 (2026-07-04)
- Initial V5 release: wallet, payments, accounting, policies, RBAC, tenant isolation
