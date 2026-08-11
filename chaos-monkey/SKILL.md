---
name: chaos-monkey
description: Adversarial and exhaustive app testing against local, staging or production. Hunts runaway queries and N+1s, single user resource amplification, missing rate limits, dead buttons, broken flows, 404s and edge cases, then produces a remediation plan with executable acceptance criteria per finding and drives a fix-verify loop until every gap closes and graduates into automatic CI runners. Use whenever the user asks to break the app, stress or load test it, fuzz inputs, find edge cases, hunt bugs, test unhappy paths, check that all buttons and links work, verify no 404s, detect N+1 or slow queries, decide what rate limits or pagination caps to implement, test production safely, build a QA suite, get acceptance criteria for fixes, or set up automated test runners in CI. Also trigger on casual phrasings like "try to break this", "what happens if", "test the limits", "QA this feature", "why is this page slow", or "can one user take us down". Use it even when only one screen or form is named.
---

# Chaos Monkey

Five questions this answers, in priority order:

1. **Can one user overwhelm the system?** Runaway queries, N+1s, unbounded pagination,
   missing limits. This is the one that causes outages.
2. **What limits should exist?** A measured proposal with a number and a justification for
   each, not guesses.
3. **Does everything actually work?** Every route, button and flow, in every role, no 404s,
   no dead ends.
4. **What breaks under adversarial use?** Edge cases, races, tenant leaks, state violations.
5. **How do we close each gap and prove it stayed closed?** A remediation plan where every
   finding carries executable acceptance criteria, driven in a loop until verified.

Two structural commitments shape everything below.

**The mode is a permission model, not a setting.** The same probe that is responsible
locally is reckless against live customers. Declare the mode explicitly, and let
`scripts/mode-guard.ts` refuse disallowed capabilities rather than trusting anyone to
remember. See `references/environments.md`.

**Exploration is temporary; the runners are permanent.** A session ending in a bug report
must be repeated forever. A session ending in tests never has to be repeated. Everything
graduates.

---

## Step 0: Declare the mode

Never infer it. Ask, and set `CHAOS_MODE`.

| Mode | Target | Posture |
|---|---|---|
| `local` | localhost, docker, ephemeral DB | everything permitted |
| `staging` | staging, preview, seeded clone | everything except unscheduled sustained load |
| `production` | live app, real users | read dominant, synthetic accounts, hard abort conditions |

**Production requires all seven preconditions confirmed in writing before anything runs**:
ownership and authorization, synthetic canary accounts holding no real customer data, data
tagging, on call notified, a kill switch, a rollback path, and a low traffic window. Read
`references/environments.md` and work through them explicitly. If any cannot be met, run
staging and say so rather than relaxing the rules to fit the schedule.

Two things never run in production regardless of permission: the **random monkey**, whose
whole value is unpredictability, which is exactly what makes it unacceptable near real
users; and **anything destructive**, including deletes against synthetic records, since a
delete path behaving unexpectedly is the bug class being hunted.

Production is not a lesser staging. It uniquely answers questions about real data shape,
real query telemetry, real config and real integrations, and it is where continuous
synthetic monitoring of the happy paths lives.

---

## Phase 1: Recon

Map the surface from source, not the UI. Produce `chaos/inventory.md` and
`chaos/routes.json`: every route with roles that should and should not reach it, every
endpoint with the auth check guarding it, every form field with client validation and
server validation and DB constraint side by side, every list view and export and report,
every status column and its legal transitions, every money calculation, every place an ID
arrives from the client, and all webhooks, jobs and subscriptions.

Flag two lists loudly: **fields where client validation is stricter than server
validation**, and **endpoints with no pagination cap**. The first real bugs come from there.

## Phase 2: Instrument and seed

Prerequisites, not testing. Skipping them makes everything after unreliable.

**Instrument.** Per request query counting emitting `X-Query-Count` and `X-Query-Time`.
`scripts/query-counter.ts` covers Prisma, Drizzle, node-postgres and Supabase. Enable
`pg_stat_statements`. In production these headers can stay internal or be stripped at the
edge; the measurement still happens.

**Seed** deterministically at small (10 projects), medium (1,000), and large (100,000 rows)
with fixed IDs and a frozen clock. In production there is no seeding: real data is the
large scale, and the canary tenant is the small one.

## Phase 3: Query load and limits

Read `references/query-load.md`.

The core assertion: **query count must stay flat as row count grows.** Time may grow, count
must not. A route running 4 queries at small scale and 1,004 at large scale is an N+1, and
it looks perfect in every functional test that exists today.

Work the amplification table: unbounded pagination, deep offset, nested expansion, single
character search, unindexed sorts and filters, unbounded exports and date ranges, autosave
storms, polling, realtime fan out, tab fan out, bulk select all, recursive data. Record
query count, duration and rows for each. In production, run these one at a time with
recovery pauses and abort watching, never concurrently, and prefer reading real telemetry
over generating load.

Output `chaos/limits-proposal.md`: a specific number per limit, each justified by a
measurement. Flag the statement timeout, the only limit that protects the database from
bugs nobody predicted.

## Phase 4: Coverage crawl

Read `references/coverage.md`. Run `scripts/crawler.spec.ts` per role. Asserts no 404, no
5xx, no console errors, no error boundary, no 200-with-empty-content, no broken links or
images, no dead controls, query counts within budget.

Test routes by direct load and refresh, not only navigation. Deep link plus refresh is the
most common 404 source in a SPA and navigation never exercises it.

Two outputs beyond failures: **routes never reached from any entry point** (dead code, or
reachable only from a state nobody tests), and **dead controls** (no request, no URL
change, no DOM mutation, no focus move).

Then write flow tests: happy path plus named unhappy branches. A flow with only a happy
path is effectively untested.

## Phase 5: Adversarial pass

Read `references/attack-library.md`. Priority order: tenant isolation and IDOR, state
machine violations, money arithmetic, concurrency, input boundaries, file upload, failure
injection. Payloads in `scripts/payloads.json`. Use real requests over the UI, since the UI
hides the endpoints with no guard.

In production this runs synthetic against synthetic only. Never probe a real customer's
records to prove a leak exists; prove it between two accounts you own.

## Phase 6: Stochastic monkey

Local and staging only. `scripts/monkey.spec.ts`, seeded because an unreproducible bug is
an unfixable bug. Every run logs its seed and action sequence; on failure, shrink to the
shortest reproducing sequence and use that as the repro. Run at normal speed, max speed,
slow 3G, 320px, and keyboard only.

## Phase 7: Remediation plan

Read `references/remediation.md`. Write `chaos/findings.json` against
`scripts/findings.schema.json`, then generate `chaos/remediation-plan.md` from it.

Every finding carries root cause, fix approach with the files and a code sketch, the other
surfaces sharing that root cause, effort, risk, and **acceptance criteria that a machine
can execute**.

Two rules make the criteria worth anything:

**Every set needs a negative and a positive.** The negative proves the bad thing is blocked.
The positive proves legitimate use still works. Verifying only the negative is how a
pagination cap ships that also breaks the export, or a tenant filter ships that also hides
a user's own records.

**Add a systemic criterion whenever the finding is an instance of a class.** Fixing the
endpoint that was found leaves the same bug on the four that were not.

The human report is ordered: executive summary in three sentences, risk table sorted by
severity then ascending effort so cheap high severity items sit at the top, an ordered fix
sequence grouped by shared root cause, full findings, limits proposal, honest coverage
statement, and for production runs the synthetic data residue.

## Phase 8: The loop

```
explore → findings.json → pick highest severity open → write failing test FIRST
   ↑                                                        ↓
   └── re-explore after a tier clears ← verify ← implement fix
```

Drive it with the prompt in `references/remediation.md`. The rules that keep it converging:

- **One finding at a time.** Batched fixes make it impossible to attribute a new failure.
- **Failing test first, confirmed failing for the right reason.** A test written after the
  fix by whoever wrote the fix tends to be a test that passes.
- **Re-run the whole phase, not just the criteria.** Fixes introduce adjacent breakage
  constantly, and the criteria will not catch it.
- **Cap attempts at three,** then escalate with what was tried. Past three the model is
  guessing, and guessing leaves speculative changes behind.
- **Re-explore after each severity tier clears.** Fixes change the surface and new surface
  has new edges.
- **Never edit acceptance criteria to make them pass.** A wrong criterion is itself a
  finding: revise it deliberately and record why.

Only the verification step writes `verified`, never the step that implemented the fix.

## Phase 9: Graduate to runners

Read `references/ci-runners.md`. Four things graduate from every session: each confirmed bug
becomes a named regression test, each monkey seed that found something joins the fixed seed
list replayed forever, each measurement becomes a `budgets.json` entry, each discovered
route and control joins the expected inventory so disappearance fails the build.

Three tiers: PR smoke under 3 minutes, merge suite under 15, nightly at large scale with
fresh seeds and load tests. Tag `@smoke`, `@isolation`, `@budget`, `@flow`, `@nightly`.

For production, add continuous synthetic monitoring: the happy path flow tests running
every few minutes forever. That converts the suite from a release gate into an outage
detector, and it is often the single highest value artifact here.

---

## Output structure

```
chaos/
├── inventory.md          surface area, roles, validation gaps
├── routes.json           route list for the crawler
├── invariants.md         oracles plus runnable checks
├── budgets.json          per route query and time ceilings
├── limits-proposal.md    measured limits with justification
├── findings.json         machine readable, drives the loop
├── remediation-plan.md   human report generated from findings.json
├── crawl-<role>.json     coverage, unreached routes, issues
├── runs/<seed>.json      monkey action logs
├── evidence/             response bodies, traces, screenshots
└── regressions/          permanent tests written from findings
```

## Severity

- **S1** Cross tenant exposure, data loss, money wrong, auth bypass, one user can degrade
  the app for everyone
- **S2** Core flow blocked, unrecoverable stuck state, silent failure, N+1 growing with
  customer data
- **S3** Recoverable wrong behavior, validation gap with no data impact, dead control
- **S4** Cosmetic

## Working style

Report findings as they land. An S1 usually wants fixing before the run finishes.

Never report a bug that was not observed. Hypotheses go in the `unverified` list. A padded
count destroys trust in the whole report.

State what was not tested and why. Silence that implies coverage is worse than an honest
gap.

During exploration, find rather than fix. Mixing them means exploration stops early. Fixing
has its own phase.

## Reference files

- `references/environments.md` Modes, capability matrix, production preconditions, abort conditions, cleanup
- `references/remediation.md` Findings format, acceptance criteria patterns, the loop and its rules
- `references/query-load.md` Instrumentation, N+1 detection, amplification vectors, limits, load testing
- `references/coverage.md` Route crawl, 404 sources, dead control detection, flow tests
- `references/ci-runners.md` Tiers, graduation, budget ratcheting, GitHub Actions, anti rot rules
- `references/attack-library.md` Attack classes by component type
- `references/bug-report.md` Prose report format and worked example
- `scripts/mode-guard.ts` Runtime enforcement of the capability matrix and abort watcher
- `scripts/findings.schema.json` Schema for findings and acceptance criteria
- `scripts/query-counter.ts` Per request query instrumentation
- `scripts/crawler.spec.ts` Coverage crawler
- `scripts/monkey.spec.ts` Seeded chaos harness
- `scripts/budgets.json` Route budgets and proposed limits
- `scripts/load.k6.js` Load scenarios including single user abuse
- `scripts/payloads.json` Fuzzing strings
