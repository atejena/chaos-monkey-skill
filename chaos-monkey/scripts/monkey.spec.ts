/**
 * Seeded chaos monkey harness (Playwright).
 *
 * Why seeded: an unreproducible bug is an unfixable bug. Every run records its
 * seed and its full action sequence, so any failure can be replayed exactly and
 * then shrunk to a minimal repro.
 *
 * Run:
 *   BASE_URL=http://localhost:3000 npx playwright test monkey.spec.ts
 *   SEED=4471029 npx playwright test monkey.spec.ts          # replay a run
 *   ACTIONS=500 SPEED=fast npx playwright test monkey.spec.ts
 *   REPLAY=chaos/runs/4471029.json npx playwright test monkey.spec.ts  # exact replay
 *
 * Adapt before first use:
 *   1. login() with real test credentials
 *   2. SAFE_PATHS and BLOCKED_TEXT so the monkey stays inside the test tenant
 *   3. checkInvariants() with the app's real oracles (this is where the value is)
 */

import { test, expect, Page, ConsoleMessage } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SEED = Number(process.env.SEED ?? Date.now() % 1e7);
const ACTION_COUNT = Number(process.env.ACTIONS ?? 200);
const SPEED = process.env.SPEED ?? 'normal'; // normal | fast | slow
const REPLAY_FILE = process.env.REPLAY;
const RUN_DIR = 'chaos/runs';

// Guardrail: refuse to run against anything that is not obviously local or staging.
const SAFE_HOST = /localhost|127\.0\.0\.1|staging|\.test|\.local|preview/;

// Keep the monkey inside the test tenant and away from destructive escape hatches.
const SAFE_PATHS = ['/dashboard', '/projects', '/selections', '/change-orders', '/settings'];
const BLOCKED_TEXT = /delete account|close account|cancel subscription|log ?out|sign ?out|billing|delete organization/i;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32). Same seed, same run.
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(SEED);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------
const payloads = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'payloads.json'), 'utf8')
);

function fuzzString(): string {
  const pool = [
    ...payloads.empty_and_whitespace,
    ...payloads.unicode,
    ...payloads.injection_probes,
    ...payloads.numbers,
    ...payloads.dates,
    ...payloads.emails,
    'a'.repeat(Math.floor(rand() * 5000)),
  ];
  return String(pick(pool));
}

// ---------------------------------------------------------------------------
// Error collection. The monkey is deaf without these.
// ---------------------------------------------------------------------------
type Finding = { type: string; detail: string; afterAction: number };
const findings: Finding[] = [];
const actionLog: { i: number; action: string; target?: string; value?: string }[] = [];
let actionIndex = 0;

function attachListeners(page: Page) {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter known third party noise here, but filter narrowly.
      if (/favicon|ResizeObserver loop/i.test(text)) return;
      findings.push({ type: 'console.error', detail: text, afterAction: actionIndex });
    }
  });

  page.on('pageerror', (err) => {
    findings.push({ type: 'uncaught-exception', detail: err.message, afterAction: actionIndex });
  });

  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    if (/ERR_ABORTED/.test(failure)) return; // navigation cancels are expected
    findings.push({ type: 'request-failed', detail: `${req.method()} ${req.url()} ${failure}`, afterAction: actionIndex });
  });

  page.on('response', async (res) => {
    if (res.status() >= 500) {
      findings.push({ type: 'server-error', detail: `${res.status()} ${res.request().method()} ${res.url()}`, afterAction: actionIndex });
    }
    if (res.status() === 401 || res.status() === 403) {
      // Not automatically a bug, but worth surfacing: unexpected auth failures
      // often mean a session was silently dropped mid flow.
      findings.push({ type: 'auth-error', detail: `${res.status()} ${res.url()}`, afterAction: actionIndex });
    }
  });

  page.on('dialog', async (d) => {
    findings.push({ type: 'dialog', detail: d.message(), afterAction: actionIndex });
    await d.dismiss().catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Login. Replace with the real flow.
// ---------------------------------------------------------------------------
async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', process.env.TEST_EMAIL ?? 'monkey@tenant-a.test');
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD ?? 'chaos-test-password');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ---------------------------------------------------------------------------
// Invariants. THIS IS THE PART THAT MATTERS. Without real oracles here, the
// harness only proves the app does not crash, which is the least interesting
// property it has. Add DB queries, totals checks, and tenant leak checks.
// ---------------------------------------------------------------------------
async function checkInvariants(page: Page) {
  // Example 1: no raw error surface leaked to the user
  const body = await page.content().catch(() => '');
  for (const marker of ['ECONNREFUSED', 'PGRST', 'stack trace', 'Unhandled Runtime Error', 'at Object.<anonymous>']) {
    if (body.includes(marker)) {
      findings.push({ type: 'invariant:leaked-error', detail: marker, afterAction: actionIndex });
    }
  }

  // Example 2: injection probe executed
  const executed = await page.evaluate(() => (window as any).__chaos === 1).catch(() => false);
  if (executed) {
    findings.push({ type: 'invariant:xss', detail: 'injected script executed', afterAction: actionIndex });
  }

  // Example 3: template injection evaluated (7*7 rendered as 49 where a literal was entered)
  if (/\b49\b/.test(body) && actionLog.some((a) => a.value?.includes('7*7'))) {
    findings.push({ type: 'invariant:template-injection', detail: 'possible SSTI, verify manually', afterAction: actionIndex });
  }

  // TODO add app specific invariants:
  //   sum of visible line items equals displayed total
  //   no ID from the other tenant appears in any response
  //   record count before equals record count after for read only sequences
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function randomClick(page: Page) {
  const els = await page.locator('button:visible, a:visible, [role="button"]:visible, summary:visible').all();
  if (!els.length) return;
  const el = pick(els);
  const label = ((await el.textContent().catch(() => '')) ?? '').trim().slice(0, 60);
  if (BLOCKED_TEXT.test(label)) return;
  actionLog.push({ i: actionIndex, action: 'click', target: label });
  await el.click({ timeout: 2000, force: chance(0.15) }).catch(() => {});
  if (chance(0.25)) await el.click({ timeout: 1000 }).catch(() => {}); // double submit
}

async function randomType(page: Page) {
  const inputs = await page.locator('input:visible:not([type="file"]), textarea:visible').all();
  if (!inputs.length) return;
  const el = pick(inputs);
  const value = fuzzString();
  actionLog.push({ i: actionIndex, action: 'fill', value: value.slice(0, 80) });
  await el.fill(value, { timeout: 2000 }).catch(() => {});
  if (chance(0.3)) await el.press('Enter').catch(() => {});
}

async function randomSelect(page: Page) {
  const sels = await page.locator('select:visible').all();
  if (!sels.length) return;
  const el = pick(sels);
  const opts = await el.locator('option').all();
  if (!opts.length) return;
  const idx = Math.floor(rand() * opts.length);
  actionLog.push({ i: actionIndex, action: 'select', value: String(idx) });
  await el.selectOption({ index: idx }).catch(() => {});
}

async function randomNavigate(page: Page) {
  const p = pick(SAFE_PATHS);
  actionLog.push({ i: actionIndex, action: 'goto', target: p });
  await page.goto(`${BASE_URL}${p}`, { timeout: 10000 }).catch(() => {});
}

async function randomKeyboard(page: Page) {
  const key = pick(['Tab', 'Shift+Tab', 'Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Space', 'Control+a']);
  actionLog.push({ i: actionIndex, action: 'key', value: key });
  await page.keyboard.press(key).catch(() => {});
}

async function randomHistory(page: Page) {
  const dir = chance(0.5) ? 'back' : 'forward';
  actionLog.push({ i: actionIndex, action: dir });
  await (dir === 'back' ? page.goBack() : page.goForward()).catch(() => {});
}

async function randomReload(page: Page) {
  actionLog.push({ i: actionIndex, action: 'reload' });
  await page.reload({ timeout: 10000 }).catch(() => {});
}

async function randomResize(page: Page) {
  const size = pick([
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
    { width: 1920, height: 500 },
  ]);
  actionLog.push({ i: actionIndex, action: 'resize', value: `${size.width}x${size.height}` });
  await page.setViewportSize(size).catch(() => {});
}

async function randomOffline(page: Page) {
  actionLog.push({ i: actionIndex, action: 'offline-toggle' });
  await page.context().setOffline(true).catch(() => {});
  await page.waitForTimeout(300 + rand() * 1200);
  await page.context().setOffline(false).catch(() => {});
}

const ACTIONS: Array<[(p: Page) => Promise<void>, number]> = [
  [randomClick, 34],
  [randomType, 26],
  [randomSelect, 6],
  [randomNavigate, 10],
  [randomKeyboard, 8],
  [randomHistory, 6],
  [randomReload, 4],
  [randomResize, 3],
  [randomOffline, 3],
];

function weightedAction() {
  const total = ACTIONS.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [fn, w] of ACTIONS) {
    if ((r -= w) <= 0) return fn;
  }
  return ACTIONS[0][0];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
test(`chaos monkey seed=${SEED}`, async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  if (!SAFE_HOST.test(BASE_URL)) {
    throw new Error(`Refusing to run against ${BASE_URL}. Local or staging only.`);
  }

  attachListeners(page);
  await login(page);

  const replay = REPLAY_FILE ? JSON.parse(fs.readFileSync(REPLAY_FILE, 'utf8')).actions : null;
  const delay = SPEED === 'fast' ? 0 : SPEED === 'slow' ? 800 : 150;

  for (actionIndex = 0; actionIndex < ACTION_COUNT; actionIndex++) {
    const fn = replay ? resolveReplayAction(replay[actionIndex]) : weightedAction();
    if (!fn) break;
    await fn(page);
    if (delay) await page.waitForTimeout(delay);
    if (actionIndex % 10 === 0) await checkInvariants(page);
  }

  await checkInvariants(page);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RUN_DIR, `${SEED}.json`),
    JSON.stringify({ seed: SEED, baseUrl: BASE_URL, speed: SPEED, actions: actionLog, findings }, null, 2)
  );

  const serious = findings.filter((f) => f.type !== 'auth-error');
  if (serious.length) {
    console.log(`\n${serious.length} findings. Replay with SEED=${SEED}\n`);
    for (const f of serious.slice(0, 40)) console.log(`  [${f.type}] after action ${f.afterAction}: ${f.detail}`);
  }
  expect(serious, `Findings recorded in ${RUN_DIR}/${SEED}.json`).toHaveLength(0);
});

function resolveReplayAction(entry: any) {
  const map: Record<string, (p: Page) => Promise<void>> = {
    click: randomClick,
    fill: randomType,
    select: randomSelect,
    goto: randomNavigate,
    key: randomKeyboard,
    back: randomHistory,
    forward: randomHistory,
    reload: randomReload,
    resize: randomResize,
    'offline-toggle': randomOffline,
  };
  return entry ? map[entry.action] : null;
}
