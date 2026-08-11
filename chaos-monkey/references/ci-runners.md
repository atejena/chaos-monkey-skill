# From Agentic Exploration to Automatic Runners

The end state is that nobody runs an agent to test a release. A release triggers a suite
that already knows what to look for. Getting there depends on one discipline: **every
agentic session must end by writing deterministic tests.** An exploration that produces
only a bug report has to be repeated forever. An exploration that produces tests never
has to be repeated at all.

## The graduation pipeline

```
agentic exploration  →  finding  →  deterministic test  →  tiered runner  →  budget ratchet
     (expensive,          (once)      (written once)        (runs forever)     (prevents drift)
      occasional)
```

Four things graduate out of an agentic session:

1. **A confirmed bug** becomes a regression test named after the bug.
2. **A monkey seed that found something** graduates from the random pool into the fixed
   seed list, where it runs on every build forever.
3. **A measured query count or latency** becomes an entry in `budgets.json`, asserted in CI.
4. **A newly discovered route or control** becomes an entry in the crawler's expected
   inventory, so its disappearance fails the build.

Anything that does not graduate is knowledge that will be lost.

## The tiers

Three tiers, split by how long they take, because a suite that takes 20 minutes on every
push will be disabled within a month.

### Tier 1: pull request, target under 3 minutes

Runs on every push. Blocking.

- Smoke: the 5 to 8 flows that must never break
- Route crawl over core routes only, one role
- Query budget assertions on the 10 heaviest routes
- Dead button check on primary screens
- Tenant isolation tests (these are fast and the failure is catastrophic, so they belong in
  the fastest tier despite being a security concern rather than a smoke concern)

### Tier 2: merge to main, target under 15 minutes

Blocking on merge, not on push.

- Full route crawl, every role, including the deny lists
- All flow tests, happy paths and unhappy branches
- Full regression suite from prior findings
- Fixed seed monkey runs (the graduated seeds, replayed exactly)
- Query budgets at medium scale seed
- Rate limit and error path assertions

### Tier 3: nightly and pre release, no time limit

Non blocking, but a failure opens an issue automatically.

- Large scale seed, full crawl, query budgets at 100,000 rows
- Fresh random monkey seeds, several parallel runs
- k6 load scenarios including the single user abuse scenario
- Accessibility sweep
- Dependency and migration checks

The nightly random monkey is what keeps discovery going without an agent in the loop. When
a random seed finds something, it graduates into the tier 2 fixed list and the loop
continues on its own.

## Budgets as data, not as code

Keep budgets in a checked in JSON file rather than scattered through assertions, so that
changes to them show up in review as a deliberate diff.

```json
{
  "routes": {
    "/projects":            { "maxQueries": 6,  "maxMs": 800,  "maxPayloadKb": 250 },
    "/projects/:id":        { "maxQueries": 12, "maxMs": 1200, "maxPayloadKb": 400 },
    "/change-orders/:id":   { "maxQueries": 9,  "maxMs": 900,  "maxPayloadKb": 200 }
  },
  "global": { "maxConsoleErrors": 0, "max5xx": 0, "maxQueriesGrowthRatio": 1.2 }
}
```

`maxQueriesGrowthRatio` is the important one. It asserts that query count at large scale is
no more than 1.2x query count at small scale. That single assertion catches every N+1 that
gets introduced, including the ones nobody thought to write a test for.

**Ratchet, do not loosen.** When a route legitimately needs more queries, the budget change
is a separate reviewed commit with a reason. When a route improves, tighten the budget in
the same PR. Without ratcheting, budgets drift upward until they assert nothing.

## GitHub Actions skeleton

```yaml
name: test
on:
  pull_request:
  push: { branches: [main] }
  schedule: [{ cron: '0 7 * * *' }]

jobs:
  tier1:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run db:seed -- --scale=small
      - run: npx playwright test --grep @smoke --workers=4
      - run: npx playwright test --grep @isolation
      - run: npx playwright test --grep @budget
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: tier1-traces, path: test-results/ }

  tier2:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run db:seed -- --scale=medium
      - run: npx playwright test --grep-invert @nightly
      - run: npm run monkey:fixed-seeds
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: tier2-report, path: playwright-report/ }

  tier3:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run db:seed -- --scale=large
      - run: npx playwright test --grep @budget
      - run: npm run monkey:random -- --runs=5
      - run: npm run load:k6
      - name: Open issue on failure
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner, repo: context.repo.repo,
              title: `Nightly chaos run failed ${new Date().toISOString().slice(0,10)}`,
              body: 'See the run artifacts for seeds and traces.',
              labels: ['chaos', 'bug']
            })
```

Tag tests with `@smoke`, `@isolation`, `@budget`, `@flow`, `@nightly` so the tiers are
grep expressions rather than duplicated file lists.

## Preventing the suite from rotting

The predictable failure mode is not that the tests stop finding bugs. It is that they start
failing for reasons nobody trusts, and then get skipped.

- **Zero tolerance for flakes.** A test that fails intermittently gets fixed or deleted
  within a week. A suite with three known flaky tests is a suite nobody reads.
- **No arbitrary waits.** `waitForTimeout` in a functional test is a future flake. Wait on a
  condition.
- **Deterministic seed data**, including fixed IDs, fixed timestamps, and a frozen clock
  where dates matter.
- **Every test cleans up or runs in a transaction that rolls back.** Order dependent tests
  fail mysteriously in parallel.
- **Failures must name the thing.** "Route /projects exceeded query budget: 61 queries,
  limit 6" tells someone what to do. "expect(received).toBeLessThan(expected)" does not.
- **One owner for the suite.** Shared ownership of test infrastructure means no ownership.

## When to bring the agent back

The runners handle regression. They cannot handle discovery, because they only look for
what someone already thought of. Bring the agentic exploration back for:

- A new feature area with no tests yet
- Any change to auth, roles, or tenancy
- Any change to the data model or a migration touching a shared table
- A quarterly sweep, because assumptions drift
- After a production incident, aimed at the surrounding area rather than the exact bug

Each of those sessions ends the same way: new tests, new seeds, new budget entries.
