# CLAUDE.md

`AGENTS.md` is the single source of agent instructions for this repo — read it first, then
`PROJECT_STATE.md` (current state of truth) and `TECHNICAL_TASKS.md` (live backlog).

Non-negotiables: verify previous claims before building on them; a task is done only when
the verification loop passed (`npm run check`, `npm run test:all`, `npm run invariants`,
`npm run smoke`); schema/payment-semantics/auth-policy changes need the mapped human
approval gate; docs claim exactly what tests prove, no more.
