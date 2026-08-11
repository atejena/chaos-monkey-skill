# Kickoff prompts

Run each in a **separate Claude Code session**. Recon fills context with source code, and a
model attacking on a crowded context starts reporting things it did not observe.

Set the mode first, every time:

```bash
export CHAOS_MODE=local        # or staging, or production
export BASE_URL=http://localhost:3000
```

---

## Session 1: Recon and instrumentation

```
Use the chaos-monkey skill. Mode: <local|staging|production>. Phases 1 and 2 only, no
testing yet.

If mode is production, walk me through the seven preconditions in references/environments.md
and get my written confirmation on each before touching anything. If any cannot be met, say
so and stop.

Produce chaos/inventory.md and chaos/routes.json: every route with the roles that should and
should not reach it, every endpoint with the auth check guarding it, every form field with
client validation and server validation and DB constraint side by side, every list view and
export and report, every status column with its legal transitions, every money calculation,
every place an ID arrives from the client.

Flag two lists separately and loudly: fields where client validation is stricter than server
validation, and endpoints with no pagination cap.

Then add per request query instrumentation emitting X-Query-Count and X-Query-Time, enable
pg_stat_statements, and write a deterministic three scale seed script with fixed IDs and a
frozen clock. Show me the inventory and the instrumentation diff before anything else.
```

## Session 2: Query load and limits

```
Use the chaos-monkey skill, phase 3. Mode: <mode>.

Measure query count, DB time and rows returned for every route at all three scales. Query
count must stay flat as row count grows; report any route where it does not, with the exact
numbers at each scale.

Work the amplification table in references/query-load.md. For each vector, record what one
authenticated user can cause with one request.

If mode is production: one probe at a time, never concurrent, recovery pause between each,
abort watcher running against a baseline captured in the first five minutes. Prefer reading
pg_stat_statements and APM traces from real traffic over generating load. Halt on any abort
condition and tell me rather than pushing through.

Pull the top 30 from pg_stat_statements and EXPLAIN ANALYZE the worst. Look for high call
count with low mean time, which is the N+1 signature, and large tables with more sequential
scans than index scans.

Deliver chaos/limits-proposal.md with a specific number per limit, each justified by a
measurement. Tell me which three to implement first and what each prevents.
```

## Session 3: Coverage

```
Use the chaos-monkey skill, phase 4. Mode: <mode>.

Run the crawler per role. Assert no 404, no 5xx, no console errors, no error boundary, no
200-with-empty-content, no broken links or images, no dead controls, query counts within
budget. Test every route by direct load and refresh, not only by navigation.

In production, use synthetic accounts only, rate limit the crawl, and skip destructive
controls entirely.

Report three things separately: failures, routes that exist in source but were never reached
from any entry point, and controls that fired no request, changed no URL, mutated no DOM and
moved no focus.

Then list the core flows and write a test for each: happy path plus named unhappy branches.
```

## Session 4: Adversarial and monkey

```
Use the chaos-monkey skill, phases 5 and 6. Mode: <local|staging>.

The random monkey does not run in production. If mode is production, do phase 5 only, with
synthetic tenants on both sides of every isolation probe, and skip anything destructive.

Priority order: tenant isolation and IDOR using two tenants and direct API calls rather than
the UI, then state machine violations, then money arithmetic, then concurrency, then input
boundaries, then file upload, then failure injection.

Then run the seeded monkey: normal speed, max speed, slow 3G, 320px, keyboard only. On
failure, shrink the action sequence to the shortest that still reproduces.

Report each confirmed finding as you land it. No theoretical bugs; unverified hypotheses go
in the separate list.
```

## Session 5: Remediation plan

```
Use the chaos-monkey skill, phase 7.

Consolidate everything from the previous sessions into chaos/findings.json, conforming to
scripts/findings.schema.json. For each finding: root cause, fix approach with files and a
code sketch, every other surface sharing that root cause, effort, risk, and acceptance
criteria.

Every criteria set needs at least one negative (the bad thing is now blocked) and one
positive (legitimate use still works). Add a systemic criterion whenever the finding is an
instance of a class, asserting the whole class is closed rather than the one instance found.
Every criterion must be executable: a test path with a grep tag, a command, or a SQL query,
with an expected result.

Then generate chaos/remediation-plan.md: three sentence executive summary, risk table sorted
by severity then ascending effort, an ordered fix sequence grouped by shared root cause,
full findings, limits proposal, honest coverage statement, and any production residue.

Tell me the single most important thing to fix first and why.
```

## Session 6: The loop (repeat until the queue is empty)

```
Use the chaos-monkey skill, phase 8. Work chaos/findings.json.

Take the highest severity finding with status "open", lowest effort first among equals.

1. Write the failing test at regressionTest.path with its tags. Run it. Confirm it fails,
   and that it fails for the reason in the finding rather than a setup error. Show me the
   failure output and set failedBeforeFix true.
2. Set status "fixing". Implement the remediation approach, applying it to every path in
   alsoApplyTo, not only where it was found.
3. Set status "awaiting-verification". Run every acceptance criterion in order, reporting
   each as pass or fail with output.
4. Re-run the full phase suite that produced this finding, to catch adjacent breakage the
   criteria would miss.
5. All green: status "verified" with a timestamp, regressionTest.written true. Anything
   failed: status "reopened", attempts++, record what failed. At attempts 3, stop and
   escalate to me with what was tried.
6. Next finding. When no S1 remains open, re-run exploration before starting S2, since fixes
   change the surface.

Never modify acceptanceCriteria to make them pass. Never mark verified without a clean phase
suite run. One finding at a time.
```

## Session 7: Graduate to runners

```
Use the chaos-monkey skill, phase 9.

1. Confirm every verified finding has a tagged regression test in the suite
2. Move every monkey seed that found something into the fixed seed list
3. Update budgets.json with the improved measurements, plus the maxQueriesGrowthRatio
   assertion comparing large scale to small
4. Freeze the discovered route and control inventory so a disappearance fails the build

Then wire three CI tiers with tags @smoke, @isolation, @budget, @flow, @nightly: tier 1 on
PR under 3 minutes blocking, tier 2 on merge under 15 minutes, tier 3 nightly at large scale
with fresh random seeds and k6, opening an issue automatically on failure.

Then set up continuous synthetic monitoring: the happy path flow tests running against
production every 5 minutes using the synthetic account, alerting on failure.

Show me the workflow file and each tier's runtime. If tier 1 exceeds 3 minutes, tell me what
to move rather than accepting a slow blocking suite.
```

---

## Notes

**Instrumentation before anything else.** Until every response reports its query count, the
performance half of this is guesswork. One afternoon of work, and it makes every existing
test double as a performance test.

**Two tenants, always.** Without a second tenant the isolation category is untestable, and
it holds the only bugs that can end a business. In production, both sides must be synthetic
accounts you own.

**Production earns its window on things staging cannot answer**: real data shape, real query
telemetry, real config, real integrations. Do not spend a production window re-running what
staging already covered.

**The failing test comes first.** A test written after the fix by whoever wrote the fix tends
to pass regardless of whether the bug is gone.

**Negative and positive criteria, always.** Roughly half the regressions introduced by limit
and security fixes come from verifying only that the bad thing stopped.

**Ratchet budgets, never loosen silently.** An increase should be its own commit with a
reason in the message.

**Zero tolerance for flaky tests.** Fix or delete within a week. Three known flakes and
nobody reads the suite, which is how automated testing dies.
