# Bug Report Format

Write findings into `chaos/findings.md`, sorted by severity. One block per finding. Keep repro steps literal enough that someone can follow them without asking a question.

## Template

```markdown
### [S1] Short title stating the impact, not the action

**Surface:** route, endpoint, or component
**Found by:** targeted probe | monkey run seed 4471029
**Reproducible:** yes, 5/5 attempts

**Repro**
1. Literal step with the exact values used
2. ...
3. ...

**Expected:** what should have happened
**Actual:** what happened, including the raw response or DB state
**Evidence:** response body, SQL result, console error, screenshot path
**Invariant broken:** which invariant from invariants.md, if any
**Blast radius:** who is affected and how bad it is in production terms
**Suspected cause:** file and line if identified, otherwise say unknown
**Fix sketch:** one or two sentences, only if confident
```

## Worked example

```markdown
### [S1] Client user can read change orders belonging to another company

**Surface:** GET /api/change-orders/:id
**Found by:** targeted probe, attack library section 1
**Reproducible:** yes, 5/5

**Repro**
1. Log in as owner@tenant-a.test, open project "Maple Ave", note change order ID `co_8f21a`
2. Log in as client@tenant-b.test in a private window
3. Run: `curl -H "Authorization: Bearer <tenant B token>" https://staging.app/api/change-orders/co_8f21a`

**Expected:** 404
**Actual:** 200 with the full record, including cost, markup, and the client contact email
**Evidence:** response body saved at chaos/evidence/co-8f21a-leak.json
**Invariant broken:** "No response to tenant A ever contains an ID belonging to tenant B"
**Blast radius:** any authenticated user can read every change order in the system if they learn an ID. IDs appear in approval emails, so a forwarded email is enough.
**Suspected cause:** route handler queries by id only; the tenant filter exists in the list handler but not the detail handler
**Fix sketch:** add the tenant scope to the detail query and add an RLS policy so the DB enforces it independently of the handler.
```

## Also report

At the end of `findings.md`, add two short sections:

**Worth checking (not confirmed):** hypotheses formed during testing that could not be reproduced or verified. Label them clearly as unverified so nobody chases a ghost.

**Not tested:** surfaces skipped, with the reason. Missing credentials, no test data, third party sandbox unavailable. This section is what keeps the report honest about coverage.
