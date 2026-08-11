# Remediation, Acceptance Criteria, and the Loop

A findings list is a description of a problem. What closes the gap is a remediation plan
where every item carries a definition of done that a machine can evaluate. Without that,
"fixed" means "someone said so," and the loop cannot run unattended.

So every finding produces three things: a root cause, a fix approach, and acceptance
criteria that are executable.

## The two rules that make acceptance criteria work

**Rule 1: every criteria set needs a negative check and a positive check.**

The negative proves the bad thing is now blocked. The positive proves legitimate use still
works. A fix verified only by the negative is how a pagination cap ships that also breaks
the export feature, or a tenant filter ships that also hides a user's own records. Roughly
half of the regressions introduced by security and limit fixes come from skipping the
positive check.

**Rule 2: write the verification before the fix, and watch it fail.**

A test written after the fix, by whoever wrote the fix, tends to be a test that passes.
Watching it fail first is the only cheap proof that it is actually measuring the thing.
The loop enforces this ordering.

## Findings file format

`chaos/findings.json` is the machine readable source of truth. `chaos/findings.md` is
generated from it for humans. The schema is in `scripts/findings.schema.json`.

```json
{
  "run": { "id": "2026-08-08-01", "mode": "staging", "phases": ["recon", "query-load"] },
  "findings": [
    {
      "id": "CM-004",
      "severity": "S1",
      "title": "Project list endpoint accepts unbounded limit, one request scans the whole table",
      "surface": "GET /api/projects",
      "category": "amplification",
      "evidence": {
        "repro": [
          "Authenticate as any user",
          "curl -H 'Authorization: Bearer <token>' '$BASE/api/projects?limit=1000000'"
        ],
        "measured": {
          "queryCount": 3,
          "dbTimeMs": 41200,
          "rowsReturned": 98431,
          "payloadKb": 84000,
          "scale": "large"
        },
        "artifact": "chaos/evidence/CM-004-response-headers.txt"
      },
      "impact": "One authenticated user can hold a DB connection for 41 seconds and return 84MB. Ten concurrent requests exhaust the pool and take the app down for everyone.",
      "rootCause": "The limit query param is passed to the query builder without a ceiling. The UI never sends more than 25, so this was never observed.",
      "remediation": {
        "approach": "Clamp limit server side at the parsing layer, not in each handler, so new endpoints inherit it. Return the effective limit in the response so clients can detect clamping.",
        "files": ["src/lib/api/pagination.ts", "src/app/api/projects/route.ts"],
        "sketch": "const limit = Math.min(Math.max(parseInt(raw ?? '25', 10) || 25, 1), MAX_PAGE_SIZE)",
        "alsoApplyTo": ["/api/change-orders", "/api/selections", "/api/documents"],
        "effort": "S",
        "risk": "Low. Verify no internal caller depends on fetching everything in one page; the export path is the likely one.",
        "limitProposed": { "maxPageSize": 100 }
      },
      "acceptanceCriteria": [
        {
          "id": "CM-004-AC1",
          "type": "negative",
          "statement": "Given any authenticated user, when requesting limit=1000000, then at most 100 records return and the response completes in under 1 second",
          "verify": {
            "kind": "test",
            "path": "tests/limits/pagination.spec.ts",
            "grep": "@budget clamps oversized limit",
            "expect": "pass"
          }
        },
        {
          "id": "CM-004-AC2",
          "type": "positive",
          "statement": "Given a user with 250 projects, when paginating with the default page size, then all 250 are retrievable across pages with no duplicates and no gaps",
          "verify": { "kind": "test", "path": "tests/limits/pagination.spec.ts", "grep": "@flow pagination returns complete set", "expect": "pass" }
        },
        {
          "id": "CM-004-AC3",
          "type": "negative",
          "statement": "Given the same clamp, when limit is negative, zero, non numeric or absent, then the default of 25 applies and no error is thrown",
          "verify": { "kind": "test", "path": "tests/limits/pagination.spec.ts", "grep": "@budget rejects malformed limit", "expect": "pass" }
        },
        {
          "id": "CM-004-AC4",
          "type": "systemic",
          "statement": "Given every list endpoint in the route inventory, when requested with limit=1000000, then none returns more than 100 records",
          "verify": { "kind": "test", "path": "tests/limits/pagination.spec.ts", "grep": "@budget all list endpoints clamp", "expect": "pass" }
        },
        {
          "id": "CM-004-AC5",
          "type": "budget",
          "statement": "Given the large scale seed, when loading /api/projects, then db time stays under 800ms and query count under 6",
          "verify": { "kind": "command", "command": "npm run test:budget -- --route=/api/projects --scale=large", "expect": "exit 0" }
        }
      ],
      "regressionTest": { "path": "tests/limits/pagination.spec.ts", "tags": ["@budget", "@smoke"], "written": false },
      "status": "open",
      "attempts": 0,
      "verifiedAt": null
    }
  ]
}
```

The `systemic` criterion in that example is the one people skip and the one that pays.
Fixing the endpoint that was found leaves the same bug on the four that were not. Whenever
a finding is an instance of a class, add a criterion that asserts the class is closed.

## Criteria patterns by finding category

Reach for the matching shape rather than inventing one each time.

| Category | Negative | Positive | Systemic |
|---|---|---|---|
| Tenant leak | Tenant B gets 404 for tenant A's ID on every verb | Tenant A still reads and writes its own records | Every endpoint taking an ID is covered by the isolation suite |
| N+1 | Query count at large scale is within 1.2x of small scale | The page still renders all expected data | The growth ratio assertion covers every list route |
| Missing limit | The abusive request is rejected or clamped | The legitimate maximum still succeeds | Every endpoint of the same shape enforces it |
| Rate limit | Burst above the ceiling returns 429 with Retry-After | Normal usage never sees a 429 | UI renders 429 as a real message, verified |
| 404 or dead route | Direct load plus refresh returns 200 for every role that should reach it | Denied roles still get 403 or 404 | Crawler reaches every route in the inventory |
| Dead control | The control fires a request or changes state | The action it performs actually completes correctly | Dead control check passes on every crawled route |
| State machine | The illegal transition returns an error and the record is unchanged | Every legal transition still works end to end | The full transition matrix is asserted |
| Race or double submit | Two concurrent identical submits produce exactly one record | A genuine second submission still creates a second record | Idempotency covers every mutating endpoint |
| Money | The computed total matches the sum to the cent at every boundary value | Normal calculations unchanged | List view, detail view and exported document all agree |
| Input validation | The hostile payload is rejected or safely stored | Valid unicode, long names and legitimate edge values still save | Server validation is at least as strict as client validation everywhere |

## Writing the report

`chaos/remediation-plan.md` is the human deliverable, generated from findings.json.
Structure it as:

1. **Executive summary.** What was tested, in which mode, at which scales, and the single
   most important thing to fix. Three sentences.
2. **Risk table.** Every finding by ID, severity, one line impact, effort. Sorted by
   severity then by effort ascending, so the cheap high severity items are visibly at the
   top.
3. **Fix sequence.** An ordered plan, grouped where fixes share a file or a root cause, with
   dependencies noted. This is what turns a list into a schedule.
4. **Full findings.** Each with evidence, root cause, approach, criteria.
5. **Limits proposal.** The measured table.
6. **Coverage statement.** What was tested, what was skipped and why.
7. **Residue.** For production runs, what synthetic data was created and removed.

Effort as S, M, L rather than hours, since hour estimates on someone else's codebase are
false precision.

## The loop

```
   ┌──────────────────────────────────────────────────────┐
   │                                                      │
   ▼                                                      │
 explore ──► findings.json ──► pick highest severity open  │
                                        │                 │
                                        ▼                 │
                              write failing test first    │
                                        │                 │
                                        ▼                 │
                                  implement fix           │
                                        │                 │
                                        ▼                 │
                              run acceptance criteria     │
                                   │         │            │
                            all pass    any fail          │
                                   │         │            │
                                   ▼         └─► reopen, attempts++
                          run full phase suite            │
                                   │                      │
                          no new failures                 │
                                   │                      │
                                   ▼                      │
                          mark verified, tag test ────────┘
                                   │
                          queue empty ──► graduate to CI tiers
```

### Loop rules

**One finding at a time.** Batching fixes makes it impossible to tell which change caused a
new failure, and something usually does.

**The failing test comes first.** Write it, run it, confirm it fails for the right reason.
A test that passes before the fix is measuring the wrong thing, and it will pass forever
regardless of whether the bug returns.

**Re-run the phase, not just the criteria.** After each fix, re-run the whole phase that
found it. Fixes introduce adjacent breakage constantly: a tenant filter that hides
legitimate records, a clamp that breaks the export, a debounce that drops the last
keystroke. The acceptance criteria will not catch these. The phase suite will.

**Cap attempts at three.** After three failed attempts on one finding, stop and escalate
with what was tried and why each attempt failed. Beyond three, the model is usually
guessing, and the cost of guessing is a codebase full of speculative changes.

**Re-explore after each severity tier clears.** Once every S1 is verified, run a fresh
exploration pass before starting on S2. Fixes change the surface, and the new surface has
new edges. This is also where a fresh random monkey seed earns its keep.

**Never edit acceptance criteria to make them pass.** If a criterion turns out to be wrong,
that is a finding about the criterion: record why, revise it deliberately, and note the
revision in the report. Silently relaxing the definition of done is how a loop converges on
nothing.

### Status lifecycle

```
open ──► fixing ──► awaiting-verification ──► verified
  ▲                          │
  └────── reopened ◄─────────┘  (any criterion failed, or the phase suite regressed)
```

Only the verification step writes `verified`, and only when every criterion passed and the
phase suite is clean. A finding is never marked verified by the same action that
implemented the fix.

### Driving the loop from Claude Code

```
Read chaos/findings.json. Take the highest severity finding with status "open",
lowest effort first among equals. Then:

1. Write the failing test at its regressionTest.path with the listed tags. Run it.
   Confirm it fails, and confirm it fails for the reason in the finding rather than a
   setup error. Show me the failure output.
2. Set status to "fixing". Implement the remediation approach. Apply it to every path in
   alsoApplyTo, not only the surface where it was found.
3. Set status to "awaiting-verification". Run every acceptance criterion in order and
   report each as pass or fail with its output.
4. Re-run the full phase suite that produced this finding.
5. If everything is green, set status "verified" with a timestamp and mark regressionTest
   written. If anything failed, set status "reopened", increment attempts, and record what
   failed. At attempts 3, stop and escalate to me.
6. Move to the next finding. When no S1 remains open, re-run exploration before starting
   S2.

Never modify acceptanceCriteria to make them pass. Never mark verified without a clean
phase suite run.
```

### Exit condition

The loop ends when no S1 or S2 remains open, every verified finding has a tagged regression
test in the suite, budgets.json reflects the improved measurements rather than the old
ones, and the CI tiers run green. At that point the work moves permanently into the runners
described in `references/ci-runners.md`, and the agent is only needed again for new surface
area.
