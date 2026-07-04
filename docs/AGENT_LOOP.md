# Agent Development Loop

Use this loop for development work in this repo. The purpose is to let the agent make progress from machine feedback while stopping for Flo when domain judgment is required.

## The Loop

1. Read `PROJECT_STATE.md`.
2. Identify the current task and acceptance criteria.
3. Inspect the relevant code and docs before editing.
4. Create a short implementation plan.
5. Make one focused change.
6. Run the narrowest useful verification command.
7. If verification fails, inspect the exact failure.
8. Fix the proven cause, not unrelated code.
9. Repeat verification and repair up to 3 times.
10. Update `PROJECT_STATE.md`.
11. Stop with a clear summary.

## Feedback Sources

The agent can loop without constant human input by using:

- Test failures
- Syntax errors
- Integration errors
- Smoke-test output
- Service logs
- API responses
- Database invariants
- Existing task docs
- Existing acceptance criteria

Human input is only needed when the next decision depends on product, finance, compliance, or risk judgment.

## Stop Conditions

Stop and ask Flo when:

- The acceptance criteria are unclear.
- A fix requires changing business semantics.
- A fix requires changing accounting, policy, compliance, auth/RBAC, tenant isolation, payment execution, or database schema.
- The same failure remains after 3 repair attempts.
- The agent discovers conflicting docs or requirements.
- The change would become a broad refactor.

## Good Task Prompt

```text
Read AGENTS.md, PROJECT_STATE.md, and docs/AGENT_LOOP.md first.

Task: <one concrete task>

Acceptance criteria:
- <criterion 1>
- <criterion 2>
- <criterion 3>

Use the development loop:
1. Inspect relevant files.
2. Make a short plan.
3. Implement one focused change.
4. Run the narrowest useful test.
5. Repair from test/log feedback up to 3 times.
6. Update PROJECT_STATE.md.

Stop and ask before changing accounting rules, policy/compliance behavior, auth/RBAC policy, tenant isolation, payment semantics, or DB schema.
```

## Example Task Prompt

```text
Read AGENTS.md, PROJECT_STATE.md, and docs/AGENT_LOOP.md first.

Task: Fix one verified V5 auth hardening gap from docs/V5_VERIFIED_GAPS_TASK_LIST.md.

Acceptance criteria:
- Add or update a regression test that proves the old behavior.
- Implement the smallest fix.
- Run the relevant integration test.
- Update PROJECT_STATE.md with files changed, tests run, result, and next step.

Stop and ask before changing the auth/RBAC policy itself. Only implement the documented intended behavior.
```

