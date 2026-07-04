# ADR-010: Single-Process Rate Limiting Accepted for Pilot

- **Status:** Accepted
- **Date:** 2026-07-04
- **Decider:** Engineering (per V6 plan recommendation)
- **Affects:** `packages/shared/http.mjs`, `packages/shared/auth.mjs`

## Context

The platform uses in-memory `Map`-based token buckets for:

1. **API rate limiting** (`packages/shared/http.mjs`): sliding-window token buckets keyed by
   `(clientIp, bucketKey)` — general rate limit (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`)
   and state endpoint rate limit (`STATE_RATE_LIMIT_MAX`).
2. **Login brute-force lockout** (`packages/shared/auth.mjs`): failed-attempt counter keyed
   by `(clientIp, email)` with configurable max attempts, lockout window, and auto-reset
   on expiry.

Both are **per-process** — each service instance maintains its own Maps. If a service
restarts, all rate-limit and lockout state is lost. If a service runs in multiple replicas
(horizontal scaling), each replica has independent counters, defeating the protection.

## Decision

**Accept in-memory rate limiters as a documented single-instance constraint for the pilot
phase.**

No code change is required beyond documentation. The platform currently runs as a single
instance per service by design (Docker Compose single-replica; local dev single processes).
The protections (rate limiting, login lockout) work correctly under this constraint and
are verified by integration tests.

A distributed rate-limiting backend (Redis or equivalent) will be required only when Epic 7
introduces horizontal scaling, or earlier if the operations team identifies multi-instance
deployment as a near-term need.

## Consequences

- **Positive:** No new infrastructure dependency. No runtime dependency addition (preserves
  the ADR-001 zero-dependency rule for runtime deps). No code change risk. Tests continue
  to verify the single-process behavior.
- **Negative:** The constraint is real and must be enforced operationally. If someone deploys
  multiple replicas behind a load balancer without first implementing a distributed rate
  limiter, rate limiting and login lockout will silently fragment across instances.
- **Documentation:** The constraint is stated in `docs/ENVIRONMENT.md` next to the rate-limit
  variables. It is also listed in `docs/PRODUCTION_READINESS.md` as a known caveat (G5 /
  Epic 7).

## Revisit Trigger

This ADR must be revisited when **any** of the following occurs:

1. Horizontal scaling (multiple replicas of any service) is introduced — this is likely
   during Epic 7 infrastructure work.
2. A security assessment or penetration test identifies single-process rate limiters as
   insufficient for the threat model.
3. A design partner or production deployment requires distributed rate limiting before
   horizontal scaling is in place.

If any revisit trigger fires, the resolution is a Redis (or equivalent) backend with:

- Atomic counter operations.
- Configurable TTL matching the current window/lockout intervals.
- Connection from every service instance to the shared store.

The existing singleton-scope unit/integration tests will need no change; adversarial
tests against a multi-instance deployment become the new verification burden.

## References

- `packages/shared/http.mjs` lines 14–50: `rateBuckets` Map and `checkRateLimit` implementation
- `packages/shared/auth.mjs` line 18: `loginFailures` Map
- `docs/ENVIRONMENT.md` § Client IP and Rate Limiting
- `docs/PRODUCTION_READINESS.md` § Verified Gaps (G5)
- `docs/V6_PLAN.md` Epic 0, Task 0.3
- `docs/PRODUCTION_MVP_BACKLOG.md` ADR-001 (dependency policy)
