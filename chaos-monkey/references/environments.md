# Environments and Modes

The same technique that is responsible in a local container is reckless against a live
customer base. So the environment is not a URL setting, it is a permission model: the mode
determines which attack classes are legal at all, and the harness refuses the rest rather
than trusting the operator to remember.

Declare the mode explicitly at the start of every session. Never infer it.

## The three modes

| Mode | Target | Posture |
|---|---|---|
| `local` | localhost, docker, ephemeral branch DB | Everything permitted. Break it freely, reset the DB after. |
| `staging` | staging, preview, seeded clone | Everything permitted except sustained load outside an agreed window. Real integrations sandboxed. |
| `production` | live app, real users, real data | Read dominant. Synthetic accounts only. Hard abort conditions. Nothing destructive, ever. |

## Before production mode, all seven

Do not begin until every one of these is confirmed by the user, in writing, in the session.

1. **Ownership and authorization.** The user owns or is explicitly authorized to test this
   system. If any third party infrastructure is involved (a host, a payment processor, an
   auth provider), their acceptable use terms govern load testing and must be checked.
2. **Synthetic accounts.** A dedicated canary tenant and at least two synthetic users, owned
   by the company, containing no real customer data. Isolation testing runs synthetic
   against synthetic. Never probe a real customer's records to prove a leak exists; prove it
   between two accounts you own.
3. **Data tagging.** Every record created carries a marker (`is_synthetic = true`, or a
   reserved prefix such as `CHAOS-`) so it is filterable out of reports, analytics, billing
   and emails, and removable afterward.
4. **Notification.** On call and anyone watching dashboards knows the window. An alert storm
   that nobody expected costs more trust than the test earns.
5. **Kill switch.** A single command or env flag that halts every runner immediately, and the
   person running it knows it.
6. **Rollback.** A recent backup, and a known procedure. Not because the plan is destructive,
   but because the point of chaos testing is that outcomes are not fully predictable.
7. **Window.** Lowest traffic period. Never during a deploy, a migration, or a customer
   demo.

If any of the seven cannot be met, run in staging and say so plainly rather than
downgrading the safety rules to fit the schedule.

## Capability matrix

The harness enforces this. `scripts/mode-guard.ts` refuses a disallowed action rather than
warning about it, because a warning in a long run gets scrolled past.

| Capability | local | staging | production |
|---|---|---|---|
| Read every route as each role | yes | yes | yes, synthetic accounts |
| Query count and latency measurement | yes | yes | yes, passive headers only |
| Route crawl and link checking | yes | yes | yes, rate limited |
| Dead control detection | yes | yes | non destructive controls only |
| Happy path flow tests | yes | yes | yes, synthetic and tagged |
| Input fuzzing on writes | yes | yes | canary tenant records only |
| Tenant isolation probes | yes | yes | between two owned synthetic tenants only |
| State machine violation attempts | yes | yes | synthetic records only |
| Concurrency and double submit | yes | yes | synthetic records only |
| File upload abuse | yes | yes | small files only, cleaned up |
| Deletes and destructive controls | yes | yes | **never** |
| Random stochastic monkey | yes | yes | **never** |
| Amplification probes (unbounded pagination, deep nesting, wide exports) | yes | yes | **single request each, one at a time, abort on latency rise** |
| Sustained load testing (k6) | yes | scheduled | **only in an agreed window with ops present** |
| Auth brute force and rate limit probing | yes | yes | one controlled burst against a synthetic account only |
| Failure injection (offline, forced 5xx) | yes | yes | client side only, never server side |
| Schema or config mutation | yes | yes | **never** |

The two rows worth dwelling on: the **random monkey never runs in production**, because
its whole value is that its actions are unpredictable, which is exactly the property that
makes it unacceptable near real users. And **deletes never run**, even against synthetic
records, because a delete path that behaves unexpectedly is precisely the bug class you are
hunting.

## Abort conditions

In production mode, poll these continuously and halt the entire run on any breach. Chaos
testing that becomes the incident is a self inflicted outage.

| Signal | Threshold | Action |
|---|---|---|
| Overall error rate (all users, not just synthetic) | rises above baseline plus 0.5% | halt |
| p95 latency on any core route | exceeds 2x the pre run baseline | halt |
| DB connection pool utilization | above 70% | halt |
| CPU or memory on app or DB | above 80% | halt |
| Any 5xx caused by a synthetic request | first occurrence | pause, record, ask before continuing |
| Alert fires in the monitoring system | any | halt |
| Queue depth or job backlog | growing for 60 seconds | halt |

Take a baseline for the first five minutes of the window before sending a single probe.
Without the baseline there is nothing to compare against, and every judgment becomes a
guess about whether the app was always like this.

## Pacing in production

- One amplification probe at a time, never concurrent, with a recovery pause between them
- Cap synthetic traffic at a small fraction of real traffic (1% is a reasonable ceiling)
- Respect the app's own rate limits rather than testing through them; getting a 429 is a
  pass, not an obstacle
- Prefer reading production telemetry over generating load. `pg_stat_statements`, APM
  traces and slow query logs from real traffic are better evidence than synthetic probes,
  and they cost nothing
- Sequential, not parallel. The parallelism is what turns a probe into a load test

## What production is uniquely good for

Production mode is not a lesser version of staging. It answers questions staging cannot,
and those are the ones worth spending the window on.

- **Real data shape.** The customer with 40,000 line items in one project exists only here.
  Staging seed data never has the distribution that breaks things.
- **Real query telemetry.** `pg_stat_statements` under real traffic ranks the actual
  offenders. No synthetic workload approximates this.
- **Real config.** CDN, edge caching, connection pooler, env vars, feature flags, and the
  differences between them and staging are usually where the surprises live.
- **Real integrations.** Live webhooks, live email deliverability, live auth provider.
- **Continuous synthetic monitoring.** Once the happy path flow tests exist, run them against
  production every 5 minutes forever. That converts the suite from a release gate into an
  outage detector, and it is frequently the highest value thing in this whole kit.

## Cleanup

Every production run ends with a cleanup pass, and the report states explicitly what was
created and what was removed.

```sql
-- verify before removing
select count(*), min(created_at), max(created_at)
from <table> where is_synthetic = true;
```

Anything that cannot be cleaned up (an email that was sent, a webhook that fired, an audit
log entry) gets listed in the report as a known residue rather than quietly left behind.
