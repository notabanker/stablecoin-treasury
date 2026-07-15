# Corporate Stablecoin Treasury Platform — Audit & Pitch Prep

> Hand this to any frontier LLM for a complete codebase audit and pitch-readiness assessment.

---

## Mission

Audit the entire Corporate Stablecoin Treasury Platform codebase and prepare it for a real investor pitch. Two outputs required:

1. **Audit Report** — all bugs, gaps, and risks
2. **Pitch Readiness** — what must be fixed/improved before showing to investors

---

## Machine Location

```
Project Root: /Users/notabanker/projects/corporate-stablecoin-treasury-platform
Branch:       main (check current HEAD)
Package Mgr: npm
Tests:        npm run test:all
Dev Stack:    docker-compose up (requires local Postgres)
```

---

## Read These First (in order)

1. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/PROJECT_STATE.md` — live working memory, current task, block status
2. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/README.md` — project overview
3. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/docs/ARCHITECTURE.md` — service map and design
4. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/docs/PRODUCTION_READINESS.md` — current gaps
5. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/docs/V3_PLAN.md` or `docs/` latest plan
6. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/TECHNICAL_TASKS.md` — backlog

---

## Project Structure

```
corporate-stablecoin-treasury-platform/
├── apps/
│   └── web/                          # Treasury operations UI
├── services/
│   ├── api-gateway/                  # API gateway / auth
│   ├── wallet-service/               # Wallet management
│   ├── payment-service/              # Payment processing
│   ├── accounting-service/           # Journal entries, GL
│   ├── compliance-service/           # KYC/AML, sanctions, limits
│   ├── policy-service/               # Policy engine (4-eyes, limits)
│   ├── reconciliation-service/       # Transaction reconciliation
│   ├── operations-service/           # Admin operations
│   ├── job-worker/                   # Background jobs
│   └── relay-worker/                 # Event relay
├── packages/
│   └── shared/                       # Shared helpers, config, clients
├── db/                               # Database migrations / seeds
├── docs/                             # Architecture, production, plans
├── infra/                            # Infrastructure as code
├── scripts/                          # Helper scripts
├── tests/                            # Integration / E2E tests
├── docker-compose.yml                # Local stack
├── Dockerfile                        # Production build
├── PROJECT_STATE.md                  # Live working memory
├── TECHNICAL_TASKS.md                # Backlog
└── HANDOFF.md                        # Previous agent handoff
```

---

## Key Source Files by Service

### API Gateway (`services/api-gateway/src/`)
- `index.mjs` — entry point, middleware, routing
- Auth handlers, RBAC middleware
- Rate limiting, request validation

### Wallet Service (`services/wallet-service/src/`)
- Wallet CRUD, balance queries
- Custody provider integration
- Address generation, signing

### Payment Service (`services/payment-service/src/`)
- Payment state machine
- Transfer orchestration
- Approval workflows
- Provider submission

### Accounting Service (`services/accounting-service/src/`)
- Journal entries, double-entry
- General ledger
- Trial balance
- Month-end close

### Compliance Service (`services/compliance-service/src/`)
- Sanctions screening
- Transaction monitoring
- KYC checks
- Limit enforcement

### Policy Service (`services/policy-service/src/`)
- Policy definitions
- Approval routing (4-eyes principle)
- Policy evaluation engine

### Reconciliation Service (`services/reconciliation-service/src/`)
- Transaction matching
- Exception handling
- Break resolution

### Operations Service (`services/operations-service/src/`)
- Admin functions
- Audit log queries
- System configuration

### Job Worker (`services/job-worker/src/`)
- Scheduled jobs
- Retry logic
- Dead letter queue

### Relay Worker (`services/relay-worker/src/`)
- Event publishing
- Webhook delivery
- Outbox pattern

---

## Verification Commands

```bash
cd /Users/notabanker/projects/corporate-stablecoin-treasury-platform

# 1. Check project state
cat PROJECT_STATE.md | head -5

# 2. Current git state
git log --oneline -5
git status -sb

# 3. Run all tests
npm run test:all 2>&1 | tail -20
npm run test 2>&1 | tail -5       # unit tests
npm run test:integration 2>&1 | tail -10
npm run test:concurrency 2>&1 | tail -10

# 4. Syntax/type checks
npm run check 2>&1 | tail -10

# 5. Smoke test (requires Postgres)
npm run smoke 2>&1 | tail -20

# 6. Check each service starts
for svc in services/*/; do
    name=$(basename "$svc")
    echo "=== $name ==="
    ls "$svc/src/" 2>/dev/null | head -5
done

# 7. Check for secrets in code
grep -rn "sk_\|secret\|password\|api_key\|private_key" --include="*.mjs" --include="*.ts" --include="*.js" \
    services/ apps/ packages/ 2>/dev/null | grep -v "node_modules" | grep -v "\.env" | grep -v "example\|sample\|test\|mock\|fake"
```

---

## Audit Checklist

### 🔴 Critical — Security & Compliance

1. **Secrets in code?** — Scan for hardcoded API keys, passwords, private keys
2. **Auth/RBAC correct?** — Every endpoint protected? Proper role checks?
3. **Input validation?** — SQL injection, NoSQL injection, command injection
4. **Dependency vulnerabilities?** — `npm audit` output
5. **Tenant isolation?** — Can tenant A see tenant B's data?
6. **Audit trail?** — Every financial operation logged immutably?
7. **MiCA compliance?** — Does the code reflect the regulatory requirements claimed in docs?
8. **Payment state machine?** — No invalid transitions? No lost money states?

### 🟠 High — Functionality & Correctness

9. **All services compile/start?** — Check each service individually
10. **Tests pass?** — Full suite
11. **Coverage gaps?** — Which modules have no tests?
12. **Error handling?** — Proper error responses, no crash-on-invalid-input
13. **Idempotency?** — Payment operations idempotent? Replay-safe?
14. **Dead letter queue works?** — Failed messages go to DLQ, not lost
15. **Reconciliation correct?** — Matching logic handles edge cases (partial matches, duplicates)
16. **Currency/money handling?** — Using Decimal (not float) for all monetary values?

### 🟡 Medium — Pitch Readiness

17. **README accurate?** — Does it describe what the code actually does?
18. **Architecture doc current?** — Does the diagram match reality?
19. **Demo script?** — Can someone run `docker-compose up` and see working functionality?
20. **Production readiness doc?** — Honest assessment of gaps
21. **CHANGELOG?** — Release history?
22. **Contributing guide?** — How to set up dev environment?
23. **OpenAPI/Swagger?** — API documentation?
24. **CI/CD pipeline?** — GitHub Actions status?

---

## Pitch Readiness Gaps

Specifically assess:

| Criteria | What to Check |
|---|---|
| **Value Prop Clarity** | Does the README + landing page clearly explain the problem and solution? |
| **Working Demo** | Can the stack be started locally with `docker-compose up` and demonstrate a complete workflow? |
| **Code Quality** | Is the codebase something you'd be proud to show a technical investor/CTO? |
| **Security Posture** | Are there obvious red flags (hardcoded secrets, missing auth, SQL injection)? |
| **Regulatory Claims** | Are MiCA/compliance claims backed by actual code or just aspirational? |
| **Test Coverage** | Does the test suite inspire confidence or raise questions? |
| **Documentation** | Is there enough context for a new engineer (or investor) to understand the system? |
| **Deployment** | Is there a clear path from dev → staging → production? |
| **Roadmap** | Is the technical backlog clear and prioritized? |

---

## Reporting Format

### Part 1: Audit Results

```
## 🔴 Critical (fix immediately)
- ...
## 🟠 High (fix before pitch)
- ...
## 🟡 Medium (fix before production)
- ...
## ✅ Verified Working
- ...
```

### Part 2: Pitch Readiness

```
## Strengths (what to lead with)
- ...

## Gaps (what to fix)
- ...

## Demo Viability
- Can we demo this to an investor today? Y/N
- If no, what's the minimum to get to yes?
- If yes, what should we show?

## Recommended Fix Order
1. ...
2. ...
3. ...
```

---

## Rules

- Do NOT modify any files — read-only audit
- Flag every issue with file + line number
- Be honest — this is for a real pitch, hyping broken code costs real money
- Distinguish between "aspirational" (docs say it but code doesn't do it) and "implemented"
- If tests don't pass, say so and give the failure output
