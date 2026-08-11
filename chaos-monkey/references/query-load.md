# Query Load, Amplification, and Limits

You cannot detect an N+1 from a browser. The page renders fine, the tests pass, and the
database quietly executes 400 queries for one screen. It stays invisible until a customer
with real data arrives, and then it looks like a random outage.

So the first job in this section is not testing. It is instrumentation. Until every request
reports how many queries it ran and how long they took, everything else here is guesswork.

## Contents

1. Instrument first
2. Scale seeding
3. The core assertion: query count must not grow with row count
4. Single user amplification vectors
5. Finding the expensive queries
6. Limits worth implementing
7. Load testing

---

## 1. Instrument first

Add a per request query counter in test and staging environments. The pattern: a
request scoped counter that wraps the DB client, incremented on every query, emitted as
response headers.

```
X-Query-Count: 47
X-Query-Time: 312
X-Row-Count: 1204
```

Once those headers exist, every functional test becomes a performance test for free,
because Playwright can assert on them. That single change is worth more than every other
technique in this file.

Implementation notes by stack:

- **Prisma**: `$on('query')` with AsyncLocalStorage to attribute queries to a request.
- **Drizzle**: a logger passed per connection, wrapped in AsyncLocalStorage.
- **Supabase JS**: wrap the client in a Proxy that counts `.from()` and `.rpc()` calls. Note
  that this counts round trips, not underlying queries, so pair it with `pg_stat_statements`.
- **Raw pg**: wrap `pool.query`.

Also enable in Postgres:

```sql
create extension if not exists pg_stat_statements;
alter system set log_min_duration_statement = '200ms';
```

`scripts/query-counter.ts` has a working reference implementation.

## 2. Scale seeding

Bugs of this class do not appear at 10 rows. Seed three tenants:

| Tenant | Scale | Purpose |
|---|---|---|
| small | 10 projects, 50 line items | functional tests, fast |
| medium | 1,000 projects, 50,000 line items | realistic worst customer |
| large | 100,000 rows on the biggest table | finds missing indexes and unbounded queries |

The seed script must be deterministic and re-runnable. Every measurement below gets taken
at all three scales, because the number that matters is not the absolute time, it is the
slope between them.

## 3. The core assertion

For any given route, **query count must stay flat as row count grows**. Time may grow.
Query count must not.

```
GET /projects  at small  → 4 queries
GET /projects  at medium → 4 queries   ✅
GET /projects  at large  → 4 queries   ✅

GET /projects  at small  → 12 queries
GET /projects  at medium → 1,004 queries  ❌ N+1, one query per project
```

Do this for every list view, every detail view with children, every export, and every
dashboard aggregate. Record the results into `chaos/budgets.json` as per route ceilings,
then assert them in CI. When a ceiling is exceeded, the test fails with the route name and
the delta, which is a far more actionable failure than a slow page.

Watch specifically for:

- List views that resolve a relation per row (the classic N+1)
- Anything that loads a count with `select *` instead of `count(*)`
- Permission checks that hit the DB once per item rather than once per request
- Serializers that lazily load a field
- Loops containing `await` on a DB call
- Realtime subscription handlers that refetch the whole list on every event

## 4. Single user amplification vectors

The question is: what is the most database work one authenticated user can cause with one
request? Test each of these and record the query count, the duration, and the rows returned.

| Vector | Probe | What good looks like |
|---|---|---|
| Unbounded pagination | `?limit=1000000`, `?per_page=999999`, `?limit=-1`, `?limit=abc` | Server caps at a hard maximum regardless of what was asked |
| Deep offset | `?offset=5000000` | Cursor pagination, or a capped offset. Deep offset scans are quietly brutal |
| Nested expansion | PostgREST style `?select=*,line_items(*,attachments(*,versions(*)))` | Depth capped. Supabase will happily let a client nest until the server dies |
| GraphQL depth | a query nested 15 levels, or 50 aliases of the same expensive field | Depth limit plus cost analysis |
| Search | single character query, empty query, `%`, `_`, a 5000 character query, a catastrophic regex | Minimum length, no user supplied regex, trigram index rather than `like '%x%'` |
| Sorting | sort by an unindexed column, sort by a computed column, sort by a joined column | Only allowlisted sort fields |
| Filtering | filter on an unindexed column, 200 values in an `in` clause, a date range of 100 years | Allowlisted filter fields, capped `in` size, capped range |
| Export | export everything, at large scale, then fire it 10 times concurrently | Row cap, async job with a download link, one concurrent export per user |
| Reports and aggregates | the widest date range the UI allows, then wider via the API | Precomputed or materialized, or capped |
| Bulk operations | select all then act, with 100,000 rows selected | Batched, capped, or backgrounded |
| Autosave | type continuously in a form for 60 seconds | Debounced, and one in flight request at a time |
| Polling | leave the app open on the busiest screen for 10 minutes and count requests | Backoff, or realtime instead of polling |
| Realtime | subscribe, then have another session generate 500 events | Throttled, and the client must not refetch a list per event |
| Tab fan out | open the same heavy page in 20 tabs as one user | Per user concurrency limit or request coalescing |
| Webhook or callback | replay the same webhook 100 times | Idempotent and rate limited |
| Signup and reset | request 50 password resets in a minute | Rate limited per account and per IP |
| File processing | upload 100 files at once, each triggering a thumbnail or parse job | Queued with a per user concurrency cap |
| Recursive data | create a parent that is its own ancestor, then load the tree | Cycle detection and a depth cap |

For each vector, the real finding is not "it was slow." It is "one user, one request, and
the database did 40 seconds of work." That number is the argument for the limit.

## 5. Finding the expensive queries

After a full functional run at large scale:

```sql
select calls, mean_exec_time, total_exec_time, rows, query
from pg_stat_statements
order by total_exec_time desc limit 30;
```

Two patterns matter more than raw slowness:

- **High `calls`, low `mean_exec_time`.** This is the N+1 signature. A 2ms query called
  1,200 times per page load is the problem, not the 200ms one called once.
- **`rows` far larger than anything the UI displays.** Something is fetching everything and
  filtering in application code.

Then `explain (analyze, buffers)` the top offenders and look for sequential scans on large
tables, sorts spilling to disk, and nested loops over large row counts.

Also check indexes actually used:

```sql
select relname, seq_scan, idx_scan, n_live_tup
from pg_stat_user_tables
where n_live_tup > 10000 and seq_scan > idx_scan
order by seq_scan desc;
```

Any large table with more sequential scans than index scans is a missing index.

## 6. Limits worth implementing

Turn findings into a concrete limits proposal. This table is the deliverable that the
whole section exists to produce. Fill the columns from measurement, not from instinct.

| Limit | Typical starting point | Enforced where |
|---|---|---|
| Max page size | 100, hard capped server side | API layer |
| Max offset | 10,000, or cursor pagination only | API layer |
| Max nesting depth | 3 | API layer or PostgREST config |
| Max `in` clause size | 100 | API layer |
| Max date range | 2 years | API layer |
| Min search length | 2 characters | API layer |
| Allowlisted sort and filter fields | explicit list | API layer |
| Export row cap | 50,000, async above 5,000 | job queue |
| Statement timeout | 5s for the app role, 30s for jobs | Postgres, per role |
| Request timeout | 30s | edge or gateway |
| Rate limit, read | 100/min per user | middleware |
| Rate limit, write | 30/min per user | middleware |
| Rate limit, expensive endpoints | 5/min per user | middleware |
| Rate limit, auth endpoints | 5/min per IP and per account | middleware |
| Concurrent requests per user | 10 | middleware |
| Upload size and file count | 25MB, 20 per batch | upload handler |
| Job concurrency per user | 3 | queue |
| Connection pool ceiling | below the DB max, with a queue | pooler |

The statement timeout deserves special emphasis. It is the one limit that protects the
database even from bugs nobody predicted, because it converts an outage into a single
failed request. In Supabase:

```sql
alter role authenticated set statement_timeout = '5s';
alter role anon set statement_timeout = '3s';
```

Rate limit responses must return 429 with `Retry-After`, and the UI must render that as a
real message rather than a generic failure. Test that path explicitly; a rate limit that
produces a blank screen is a new bug rather than a fix.

## 7. Load testing

Once limits exist, verify they hold. Use k6 (`scripts/load.k6.js`) rather than a browser,
since the goal is backend behavior.

Three scenarios, all against staging at medium or large scale:

1. **Realistic**: 50 virtual users on normal flows for 5 minutes. Establishes the baseline.
2. **Single user abuse**: 1 virtual user firing the worst amplification vector found in
   section 4 as fast as it can. This is the important one, because it answers whether one
   customer can degrade the app for everyone.
3. **Spike**: 0 to 200 users in 30 seconds. Checks pool exhaustion and cold start behavior.

Pass criteria: p95 latency under budget, zero 5xx, the database connection pool never
saturates, and abuse traffic gets 429s instead of degrading everyone else's p95. That last
one is the actual point of the exercise.
