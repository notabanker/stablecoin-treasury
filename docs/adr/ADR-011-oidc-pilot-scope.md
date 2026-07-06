# ADR-011: OIDC / SSO for Pilot

- **Status:** Accepted (deferred)
- **Date:** 2026-07-05
- **Decider:** Engineering (per V6 plan recommendation)

## Context

The platform currently uses local email+password authentication with salted scrypt hashing,
session cookies, CSRF protection, and RBAC. There is no OIDC/SSO integration. A pilot
design partner may or may not require single sign-on.

## Decision

**Defer OIDC/SSO to V7 unless a pilot partner explicitly requires SSO before go-live.**

If a partner requires SSO, implement generic OIDC authorization code flow against the
pilot's identity provider (Keycloak or equivalent) with:

- Keycloak in Docker Compose as the dev IdP
- OIDC login alongside local login behind a feature flag
- Post-login sessions and CSRF unchanged (the platform session model is OIDC-agnostic)
- No change to RBAC, tenant isolation, or permission models

Local email+password login is retained even if OIDC is added — it remains the fallback
for operator accounts and local development.

## Consequences

- **Positive:** No implementation risk for V6. No dependency addition. No auth surface
  expansion before the pilot scope is locked.
- **Negative:** If a partner requires SSO at the last minute, V7 must absorb the work
  with compressed timeline.
- **Documentation:** This ADR is the recorded decision. V7 backlog carries the OIDC task
  with its full scope defined above.

## Revisit Trigger

A pilot partner explicitly requires SSO, OR the platform reaches general availability
(multi-tenant production) without SSO — at which point this ADR must be reopened.

## References

- `docs/V6_PLAN.md` Epic 4, Task 4.3
- `docs/V6_TASK_LIST.md` Task 4.3
- `docs/PRODUCTION_MVP_BACKLOG.md` M4 backlog items
