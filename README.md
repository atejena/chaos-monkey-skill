# Chaos Monkey — an adversarial QA skill for Claude

**Point Claude at your app and it tries to break it — then hands you a remediation plan where every finding carries acceptance criteria a machine can execute, and drives a fix-verify loop until every gap closes.**

Chaos Monkey is a [Claude skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview): a folder of instructions plus runnable scripts that Claude loads on demand. It turns "test my app" from a vague request into a nine-phase procedure with a permission model, measured limits, executable acceptance criteria, and a graduation path into CI.

It works on any web app. The scripts assume a TypeScript/Playwright/Postgres stack, but the method and the reference docs are stack-agnostic.

---

## Table of contents

- [What it actually does](#what-it-actually-does)
- [Install](#install)
- [Your first run](#your-first-run)
- [How to use it properly](#how-to-use-it-properly)
- [What you get back](#what-you-get-back)
- [The scripts, and what you must adapt](#the-scripts-and-what-you-must-adapt)
- [Safety: modes and production](#safety-modes-and-production)
- [How this is built](#how-this-is-built)
- [Requirements](#requirements)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [License](#license)

---

## What it actually does

Five questions, in priority order. The order is the point — most QA tooling starts at #3 and never reaches #1.

| # | Question | Why it's ranked there |
|---|---|---|
| 1 | **Can one user overwhelm the system?** | Runaway queries, N+1s, unbounded pagination, missing limits. This is the one that causes outages. |
| 2 | **What limits should exist?** | You get a specific number per limit, each justified by a measurement — not a guess copied from a blog post. |
| 3 | **Does everything actually work?** | Every route, button and flow, in every role. No 404s, no dead ends, no dead controls. |
| 4 | **What breaks under adversarial use?** | Edge cases, races, tenant leaks, state machine violations, money arithmetic. |
| 5 | **How do we close each gap and prove it stayed closed?** | A remediation plan where every finding has executable acceptance criteria, driven in a loop until verified. |

Two commitments shape everything:

**The mode is a permission model, not a setting.** The same probe that is responsible against localhost is reckless against live customers. You declare `local`, `staging` or `production`, and [`mode-guard.ts`](chaos-monkey/scripts/mode-guard.ts) *throws* on a disallowed capability rather than printing a warning nobody reads.

**Exploration is temporary; the runners are permanent.** A session that ends in a bug report has to be repeated forever. A session that ends in tests never has to be repeated. Everything graduates into CI.

### The nine phases

```
0  Declare the mode              →  local | staging | production, enforced at runtime
1  Recon                         →  chaos/inventory.md, chaos/routes.json
2  Instrument and seed           →  X-Query-Count headers, 3-scale deterministic seed
3  Query load and limits         →  chaos/limits-proposal.md
4  Coverage crawl                →  chaos/crawl-<role>.json, flow tests
5  Adversarial pass              →  isolation, state, money, concurrency, input, upload
6  Stochastic monkey             →  seeded, replayable, shrinks to minimal repro
7  Remediation plan              →  chaos/findings.json + chaos/remediation-plan.md
8  The loop                      →  failing test → fix → verify → re-explore
9  Graduate to runners           →  3 CI tiers + continuous synthetic monitoring
```

---

## Install

Pick **one** of these three. All of them end with a `chaos-monkey/` folder sitting in a skills directory.

### Option A — the packaged bundle (easiest)

Download **[`dist/chaos-monkey.skill`](dist/chaos-monkey.skill)** and upload it in the Claude app when prompted to add a skill. A `.skill` file is just a zip of the skill folder, so you can also unzip it anywhere you like:

```bash
unzip chaos-monkey.skill -d ~/.claude/skills/
```

### Option B — clone this repo (best if you want to modify it)

```bash
git clone https://github.com/atejena/chaos-monkey-skill.git
mkdir -p ~/.claude/skills
cp -r chaos-monkey-skill/chaos-monkey ~/.claude/skills/
```

Or symlink it, so `git pull` keeps your copy current:

```bash
ln -s "$(pwd)/chaos-monkey-skill/chaos-monkey" ~/.claude/skills/chaos-monkey
```

### Option C — project-scoped (share it with your team via your own repo)

Put the folder inside the project you're testing and commit it:

```bash
mkdir -p .claude/skills
cp -r /path/to/chaos-monkey-skill/chaos-monkey .claude/skills/
git add .claude/skills/chaos-monkey && git commit -m "Add chaos-monkey QA skill"
```

Everyone on the team who runs Claude Code in that repo now has it, at the same version.

### Where the skills directory lives

| Scope | Path | Applies to |
|---|---|---|
| Personal | `~/.claude/skills/chaos-monkey/` | Every project you work on |
| Project | `<repo>/.claude/skills/chaos-monkey/` | That repo, for everyone who clones it |

### Verify the install

The folder must look exactly like this, with `SKILL.md` at the top level:

```
chaos-monkey/
├── SKILL.md
├── references/   (7 files)
└── scripts/      (8 files)
```

Then start a new Claude session and ask:

```
What skills do you have available?
```

`chaos-monkey` should be listed. If it isn't, see [Troubleshooting](#faq-and-troubleshooting).

---

## Your first run

You do not need to memorize anything. The skill triggers on plain language. Open Claude in your project and say:

```
Use the chaos-monkey skill. Mode: local. Base URL: http://localhost:3000.
Start with phases 1 and 2 only — recon and instrumentation. No testing yet.
```

It will also trigger on its own from casual phrasing, because the skill description covers it:

> "try to break this" · "what happens if…" · "test the limits" · "QA this feature" ·
> "why is this page slow" · "can one user take us down" · "check that all the buttons work" ·
> "find the N+1s" · "what rate limits should I set" · "build me a QA suite"

**Two things to get right on the first run:**

1. **Always state the mode.** The skill is instructed never to infer it. If you don't say it, you'll be asked.
2. **Run one phase per session.** Recon fills the context window with source code, and a model attacking on a crowded context starts reporting things it did not actually observe. Fresh session per phase.

Set the environment once per shell:

```bash
export CHAOS_MODE=local              # or staging, or production
export BASE_URL=http://localhost:3000
```

---

## How to use it properly

**[`KICKOFF-PROMPTS.md`](KICKOFF-PROMPTS.md) is the file to actually use.** It contains seven copy-paste prompts, one per session, already written to the level of specificity the skill responds best to. Run them in order:

| Session | Prompt | Produces |
|---|---|---|
| 1 | Recon and instrumentation | `inventory.md`, `routes.json`, query counter wired in, 3-scale seed |
| 2 | Query load and limits | `limits-proposal.md` with a justified number per limit |
| 3 | Coverage | Per-role crawl results, unreached routes, dead controls, flow tests |
| 4 | Adversarial and monkey | Confirmed findings, monkey seeds, minimal repros |
| 5 | Remediation plan | `findings.json` + `remediation-plan.md` |
| 6 | The loop *(repeat until the queue is empty)* | Findings moving to `verified`, regression tests written |
| 7 | Graduate to runners | CI workflow, three tiers, synthetic monitoring |

The most valuable single session is #1. Until every response carries `X-Query-Count` and `X-Query-Time`, the entire performance half of this is guesswork — and once it does, **every functional test you already have becomes a performance test for free.**

### The loop (phase 8), in detail

```
explore → findings.json → pick highest severity open → write failing test FIRST
   ↑                                                        ↓
   └── re-explore after a tier clears ← verify ← implement fix
```

Six rules keep it converging. They are enforced in the skill text, and they are the difference between a loop that closes gaps and a loop that produces plausible-looking churn:

- **One finding at a time.** Batched fixes make a new failure impossible to attribute.
- **Failing test first, confirmed failing for the right reason** — not for a setup error. A test written after the fix, by whoever wrote the fix, tends to be a test that passes.
- **Re-run the whole phase suite, not just the criteria.** Fixes introduce adjacent breakage constantly and the criteria will not catch it.
- **Cap attempts at three,** then escalate with what was tried. Past three the model is guessing, and guessing leaves speculative changes behind.
- **Re-explore after each severity tier clears.** Fixes change the surface; new surface has new edges.
- **Never edit acceptance criteria to make them pass.** A wrong criterion is itself a finding — revise it deliberately and record why.

Only the verification step is allowed to write `verified`. Never the step that implemented the fix.

---

## What you get back

Everything lands in a `chaos/` directory in your project:

```
chaos/
├── inventory.md          surface area, roles, validation gaps
├── routes.json           route list for the crawler
├── invariants.md         oracles plus runnable checks
├── budgets.json          per-route query and time ceilings
├── limits-proposal.md    measured limits with justification
├── findings.json         machine readable, drives the loop
├── remediation-plan.md   human report, generated from findings.json
├── crawl-<role>.json     coverage, unreached routes, issues
├── runs/<seed>.json      monkey action logs, replayable
├── evidence/             response bodies, traces, screenshots
└── regressions/          permanent tests written from findings
```

### Severity scale

- **S1** — Cross-tenant exposure, data loss, money wrong, auth bypass, one user can degrade the app for everyone
- **S2** — Core flow blocked, unrecoverable stuck state, silent failure, N+1 growing with customer data
- **S3** — Recoverable wrong behavior, validation gap with no data impact, dead control
- **S4** — Cosmetic

### What a finding looks like

Findings are written as JSON against [`findings.schema.json`](chaos-monkey/scripts/findings.schema.json), because the loop in phase 8 reads and writes them programmatically. The human-readable `remediation-plan.md` is generated *from* the JSON, not maintained alongside it.

```jsonc
{
  "id": "CM-004",
  "severity": "S1",
  "category": "n-plus-1",
  "title": "One user loading /projects with 5k rows can saturate the connection pool",
  "surface": "GET /api/projects",
  "foundBy": "phase 3",
  "reproducible": "5/5",
  "evidence": {
    "repro": ["Seed large scale", "GET /api/projects?limit=5000", "Read X-Query-Count"],
    "expected": "Query count flat as row count grows",
    "actual": "4 queries at small scale, 5004 at large scale",
    "measured": { "queryCount": 5004, "scale": "large", "growthRatio": 1251 }
  },
  "rootCause": "Owner is lazy-loaded per row inside the serializer",
  "remediation": {
    "approach": "Eager-load owner; cap limit at 100 server side",
    "files": ["app/api/projects/route.ts"],
    "alsoApplyTo": ["/api/change-orders", "/api/selections"],
    "effort": "S",
    "risk": "The export path relies on limit=all"
  },
  "acceptanceCriteria": [
    { "id": "AC-1", "type": "negative",  "statement": "Given 5k projects, When limit=5000, Then 400", "verify": { "kind": "test", "path": "chaos/regressions/cm-004.spec.ts" } },
    { "id": "AC-2", "type": "positive",  "statement": "Given 5k projects, When paging at 100, Then all rows reachable", "verify": { "kind": "test", "path": "chaos/regressions/cm-004.spec.ts" } },
    { "id": "AC-3", "type": "systemic",  "statement": "No list endpoint exceeds growthRatio 1.2", "verify": { "kind": "command", "command": "npx playwright test --grep @budget" } }
  ],
  "regressionTest": { "path": "chaos/regressions/cm-004.spec.ts", "tags": ["@budget"], "failedBeforeFix": true },
  "status": "open"
}
```

Two rules make acceptance criteria worth anything, and the schema enforces a minimum of two criteria per finding to make them hard to skip:

- **Every set needs a negative *and* a positive.** The negative proves the bad thing is blocked. The positive proves legitimate use still works. Verifying only the negative is how a pagination cap ships that also breaks the export, or a tenant filter ships that also hides a user's own records.
- **Add a systemic criterion whenever the finding is an instance of a class.** Fixing the one endpoint you found leaves the same bug on the four you didn't.

---

## The scripts, and what you must adapt

The scripts are working starting points, not drop-in dependencies. Three of them need your app's specifics before the first run — the skill will prompt you, but here it is explicitly.

| File | What it does | You must adapt |
|---|---|---|
| [`scripts/query-counter.ts`](chaos-monkey/scripts/query-counter.ts) | Per-request query instrumentation emitting `X-Query-Count` / `X-Query-Time`. Adapters for Prisma, Drizzle, node-postgres and Supabase. | Wire the adapter for your ORM into your request pipeline. **Highest-leverage file in the kit.** |
| [`scripts/mode-guard.ts`](chaos-monkey/scripts/mode-guard.ts) | Runtime enforcement of the capability matrix, plus the production abort watcher. Disallowed capabilities `throw`. | Set `PROD_HOST`. Extend the safe-host regex if your staging domains differ. |
| [`scripts/monkey.spec.ts`](chaos-monkey/scripts/monkey.spec.ts) | Seeded stochastic monkey (Playwright). Logs every seed and action sequence; shrinks failures to a minimal repro. | `login()` with real test credentials · `SAFE_PATHS` / `BLOCKED_TEXT` so it stays inside the test tenant · **`checkInvariants()` with your app's real oracles — this is where the value is.** |
| [`scripts/crawler.spec.ts`](chaos-monkey/scripts/crawler.spec.ts) | Per-role coverage crawl. Asserts no 404, no 5xx, no console errors, no error boundary, no 200-with-empty-content, no broken links or images, no dead controls, query counts within budget. | Roles and credentials. |
| [`scripts/budgets.json`](chaos-monkey/scripts/budgets.json) | Per-route query/time/payload ceilings asserted in CI, plus the proposed limits table. | Replace the example routes with yours. Fill from **measurement**, not instinct. |
| [`scripts/load.k6.js`](chaos-monkey/scripts/load.k6.js) | k6 scenarios. The one that matters is `singleUserAbuse`. | Endpoints and auth token. |
| [`scripts/payloads.json`](chaos-monkey/scripts/payloads.json) | Fuzzing strings: empty/whitespace, length boundaries, unicode and RTL overrides, injection *probes*, numbers, dates, files. | Nothing — but read the note below. |
| [`scripts/findings.schema.json`](chaos-monkey/scripts/findings.schema.json) | JSON Schema for findings and acceptance criteria. Source of truth for the loop. | Nothing. |

> **On `payloads.json`:** every string in it is inert. The injection strings are *detection probes*, not exploits — if a probe renders, executes, or throws, that is the finding. Use it against systems you own or are authorized to test.

### The single most important assertion in the whole kit

```json
"global": { "maxQueriesGrowthRatio": 1.2 }
```

Query count at large-scale seed divided by query count at small-scale seed. **Time may grow with row count; count must not.** A route running 4 queries at small scale and 1,004 at large scale is an N+1 that looks perfect in every functional test you have today. That one assertion catches every N+1 anyone introduces from now on, including the ones nobody thought to write a test for.

### Reference docs

Each is loaded by the skill on demand, and each is readable on its own:

| File | Covers |
|---|---|
| [`references/environments.md`](chaos-monkey/references/environments.md) | The three modes, the full capability matrix, the seven production preconditions, abort conditions, pacing, cleanup |
| [`references/query-load.md`](chaos-monkey/references/query-load.md) | Instrumentation, scale seeding, N+1 detection, the single-user amplification table, limits worth implementing, load testing |
| [`references/coverage.md`](chaos-monkey/references/coverage.md) | Route inventory from source, the real sources of 404s, dead control detection, flow tests |
| [`references/attack-library.md`](chaos-monkey/references/attack-library.md) | 12 attack classes, each as *what to do* / *what a failure looks like* — because half these bugs look like success on screen |
| [`references/remediation.md`](chaos-monkey/references/remediation.md) | Findings format, acceptance criteria patterns, the loop and its rules |
| [`references/ci-runners.md`](chaos-monkey/references/ci-runners.md) | The graduation pipeline, three tiers, budget ratcheting, GitHub Actions, anti-rot rules |
| [`references/bug-report.md`](chaos-monkey/references/bug-report.md) | Prose report format with a worked example |

---

## Safety: modes and production

**Only run this against systems you own or are explicitly authorized to test.** If third-party infrastructure is in the path — a host, a payment processor, an auth provider — their acceptable use terms govern load testing and must be checked first.

### The three modes

| Mode | Target | Posture |
|---|---|---|
| `local` | localhost, docker, ephemeral DB | Everything permitted. Break it freely, reset after. |
| `staging` | staging, preview, seeded clone | Everything except unscheduled sustained load. |
| `production` | live app, real users | Read-dominant. Synthetic accounts only. Hard abort conditions. |

### Two things never run in production, at any permission level

- **The random monkey.** Its whole value is that its actions are unpredictable — which is exactly the property that makes it unacceptable near real users.
- **Anything destructive**, including deletes against synthetic records. A delete path behaving unexpectedly is precisely the bug class being hunted.

Also never in production: schema or config mutation, and server-side failure injection.

### Production requires all seven, confirmed in writing, before anything runs

1. **Ownership and authorization** — including third-party AUP checks
2. **Synthetic accounts** — a canary tenant and ≥2 synthetic users holding no real customer data. Isolation is proven between two accounts *you own*, never by probing a real customer's records.
3. **Data tagging** — `is_synthetic = true` or a `CHAOS-` prefix, so every record is filterable out of reports, analytics, billing and emails, and removable afterward
4. **Notification** — on-call and anyone watching dashboards knows the window
5. **Kill switch** — one command or env flag halts every runner, and the person running it knows it
6. **Rollback** — a recent backup and a known procedure
7. **Window** — lowest traffic period. Never during a deploy, a migration, or a customer demo.

If any of the seven cannot be met, the skill is instructed to run staging and say so plainly, rather than relaxing the rules to fit the schedule.

### Abort conditions

In production mode these are polled continuously and any breach halts the run. Take a baseline for the first five minutes of the window before sending a single probe — without it, every judgment is a guess about whether the app was always like this.

| Signal | Threshold |
|---|---|
| Overall error rate (all users, not just synthetic) | baseline + 0.5% |
| p95 latency on any core route | 2× the pre-run baseline |
| DB connection pool utilization | > 70% |
| CPU or memory, app or DB | > 80% |
| Any 5xx caused by a synthetic request | first occurrence → pause and ask |
| Any monitoring alert fires | any |
| Queue depth or job backlog | growing for 60s |

### What production is uniquely good for

Production mode is not a lesser staging. Don't spend the window re-running what staging already covered. Spend it on what only production can answer: **real data shape** (the customer with 40,000 line items in one project exists only here), **real query telemetry** (`pg_stat_statements` under real traffic ranks the actual offenders), **real config** (CDN, edge cache, pooler, flags), **real integrations**, and **continuous synthetic monitoring** — the happy-path flow tests running every 5 minutes forever, which converts the suite from a release gate into an outage detector.

---

## How this is built

A skill is a folder with a `SKILL.md` at its root. The YAML frontmatter — `name` and `description` — is the only part always resident in the model's context; the body loads when the skill triggers, and the files under `references/` and `scripts/` load only when the body points at them. That budget is what shaped every decision below.

```
chaos-monkey/
├── SKILL.md          ~260 lines — the procedure, and nothing else
├── references/       7 docs, loaded on demand, one per phase
└── scripts/          8 executable files the skill points at rather than describes
```

**1. The description is written for retrieval, not for humans.** It's the only text that decides whether the skill fires at all, so it enumerates both the formal vocabulary (*N+1, rate limits, pagination caps, acceptance criteria, CI runners*) and the casual phrasings people actually type (*"try to break this", "what happens if", "why is this page slow", "can one user take us down"*). It ends by saying it applies **even when only one screen or form is named** — otherwise the model treats a small request as too small to warrant the skill, which is exactly when the procedure is cheapest to run.

**2. `SKILL.md` is a procedure, not a manual.** Every phase is compressed to its decisions and its outputs, then delegates: *"Read `references/query-load.md`."* The detail lives one level down. This keeps the always-loaded surface small and, more importantly, keeps the model from skimming a wall of prose and starting mid-procedure.

**3. Rules live in code wherever a rule can be violated silently.** This is the load-bearing decision. "Remember not to run the monkey against prod" is a rule that works right up until the one time it doesn't, and a warning printed during a long run gets scrolled past. So [`mode-guard.ts`](chaos-monkey/scripts/mode-guard.ts) implements the capability matrix as `guard('randomMonkey')` calls that **throw**. The document explains the matrix; the code enforces it. Same reasoning for `budgets.json` — budgets are checked-in data rather than assertions scattered through test files, so a change to one shows up in review as a deliberate diff.

**4. Findings are JSON first, prose second.** Phase 8 is a loop an agent runs largely unattended, so its state has to be machine-readable and machine-writable: `findings.json`, validated against a schema that requires `rootCause`, `remediation`, and **at least two acceptance criteria** on every finding. `remediation-plan.md` is generated from it. Writing the prose first and the data second produces reports that read well and cannot be executed.

**5. Acceptance criteria carry a `type` because that's how you enforce coverage of the failure modes.** `negative` / `positive` / `systemic` / `budget` are enum values in the schema, not a naming convention, so "did you check that legitimate use still works?" is answerable by reading the file. Roughly half the regressions introduced by security and limit fixes come from verifying only the negative.

**6. Randomness is seeded, always.** An unreproducible bug is an unfixable bug. Every monkey run records its seed and full action sequence to `chaos/runs/<seed>.json`; a failure replays exactly and then shrinks to the shortest sequence that still reproduces. Seeds that found something graduate from the random pool into a fixed list replayed on every build forever.

**7. Every session is required to end in artifacts that outlive it.** Phase 9 exists because agentic exploration is expensive and occasional while CI is cheap and constant. Four things graduate: each confirmed bug becomes a tagged regression test, each productive seed joins the fixed list, each measurement becomes a `budgets.json` entry, and each discovered route and control joins the expected inventory so its *disappearance* fails the build. The tags — `@smoke`, `@isolation`, `@budget`, `@flow`, `@nightly` — are what sort tests into the three CI tiers (PR < 3 min blocking, merge < 15 min, nightly unbounded).

**8. The working-style rules are there to counter specific known failure modes of models doing QA.** *Never report a bug that was not observed* — hypotheses go in a separate `unverified` list, because a padded count destroys trust in the entire report. *State what was not tested and why* — silence that implies coverage is worse than an honest gap. *Find, don't fix, during exploration* — mixing them means exploration stops at the first bug. *One prompt per session* — recon fills the context window with source, and a model attacking on a crowded context starts confabulating.

### Repo layout

```
.
├── README.md                    you are here
├── KICKOFF-PROMPTS.md           7 copy-paste prompts, one per session
├── LICENSE                      MIT
├── chaos-monkey/                ← the skill itself; this is the folder you install
│   ├── SKILL.md
│   ├── references/              7 on-demand docs
│   └── scripts/                 8 runnable files
└── dist/
    └── chaos-monkey.skill       zipped bundle of chaos-monkey/ for one-step install
```

---

## Requirements

**To use the skill at all:** Claude with skills support — Claude Code, or the Claude desktop app. Nothing else.

**To run the scripts as written:**

| For | You need |
|---|---|
| `crawler.spec.ts`, `monkey.spec.ts` | Node 18+, [Playwright](https://playwright.dev) (`npm i -D @playwright/test && npx playwright install`) |
| `query-counter.ts` | A Node/TypeScript server using Prisma, Drizzle, node-postgres or Supabase — adapters included for each |
| Query telemetry in phase 3 | Postgres with `pg_stat_statements` enabled |
| `load.k6.js` | [k6](https://k6.io) |
| Phase 9 CI | GitHub Actions (the examples), or any runner that can execute tagged Playwright suites |

None of it is mandatory. The reference docs and the procedure work against any stack — the scripts are the reference implementation, and phases 1, 3, 5 and 7 are valuable with nothing but the docs and a terminal.

---

## FAQ and troubleshooting

**Claude doesn't seem to know about the skill.**
Check that `SKILL.md` is at `chaos-monkey/SKILL.md` and not nested a level deeper — unzipping into a folder that already contains `chaos-monkey/` is the usual cause. Confirm the frontmatter is intact (the file must start with `---` on line 1). Then start a **new** session; skills are discovered at session start.

**It found nothing. Is my app fine?**
Check that phase 2 actually completed. Without `X-Query-Count` on responses, phase 3 has nothing to measure and will quietly find nothing. Also confirm you seeded at large scale — N+1s are invisible at 10 rows, which is exactly why they reach production.

**It reported a bug that isn't real.**
Say so, and ask it to move the item to the `unverified` list. The skill is explicitly instructed never to report an unobserved bug, and to keep hypotheses separate — but this is a norm in text, not a guard in code, so it's the one place worth reading with your own eyes. If it happens repeatedly, your session context is probably too crowded: one phase per session.

**The loop keeps reopening the same finding.**
That's working as designed up to three attempts, after which it must stop and escalate with what it tried. If it's editing the acceptance criteria instead of the code, stop it — that rule is explicit in `references/remediation.md` and a criterion that's wrong is itself a finding.

**Can I run this against production?**
Yes, and the skill has a real procedure for it — but read [`references/environments.md`](chaos-monkey/references/environments.md) in full first, and expect to confirm seven preconditions in writing. If you can't meet all seven, run staging.

**Can I use the scripts without Claude?**
Yes. `crawler.spec.ts`, `monkey.spec.ts` and `load.k6.js` are ordinary Playwright and k6 files. `budgets.json` and `findings.schema.json` are plain data. The skill orchestrates them; it doesn't own them.

**How do I keep the suite from rotting?**
Zero tolerance for flaky tests — fix or delete within a week. Three known flakes and nobody reads the suite, which is how automated testing dies. And ratchet budgets down as routes improve; loosening one should be its own commit with a reason in the message.

---

## Contributing

Issues and PRs welcome. The most useful contributions are adapters for other stacks (Rails, Django, Laravel, Go) in `query-counter.ts`, and new entries in `references/attack-library.md` — each written as *what to do* / *what a failure looks like*, since that pairing is what makes the library usable mid-run.

## License

[MIT](LICENSE). Use it, fork it, ship it.
