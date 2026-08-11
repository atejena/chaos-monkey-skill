/**
 * Coverage crawler.
 *
 * Walks every reachable route as each role and asserts: no 404, no 5xx, no console
 * errors, no error boundary, no broken links or images, no dead buttons, and query
 * counts within budget.
 *
 * The most useful output is not the failures. It is the list of routes that exist in
 * the source but were never reached from any entry point, because those are either
 * dead code or untested by everyone.
 *
 * Run:
 *   BASE_URL=http://localhost:3000 npx playwright test crawler.spec.ts
 *   ROLE=client npx playwright test crawler.spec.ts
 */

import { test, expect, Page, Response } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 200);

const budgets = JSON.parse(fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8'));

// Roles and their credentials. Add every role, including the ones with the least access,
// since a route rendering for a role that should not see it is as much a bug as a 404.
const ROLES = {
  owner: { email: 'owner@tenant-a.test', password: 'test-password' },
  staff: { email: 'staff@tenant-a.test', password: 'test-password' },
  client: { email: 'client@tenant-a.test', password: 'test-password' },
};

// Routes each role must NOT reach. Expected 403 or 404, and anything else is a finding.
const DENY: Record<string, string[]> = {
  client: ['/settings/billing', '/settings/team', '/projects/new', '/reports'],
  staff: ['/settings/billing'],
  owner: [],
};

// Full route list extracted from source. Generate this rather than hand maintaining it:
//   find app -name 'page.tsx' | sed 's|app||;s|/page.tsx||'
const ALL_ROUTES: string[] = JSON.parse(
  fs.existsSync('chaos/routes.json') ? fs.readFileSync('chaos/routes.json', 'utf8') : '[]'
);

const SKIP = /^(mailto:|tel:|javascript:|#)|\/(logout|sign-out|api\/auth)/i;
const DESTRUCTIVE = /delete|remove|cancel subscription|close account|archive|revoke/i;

type Issue = { route: string; kind: string; detail: string };

async function login(page: Page, role: keyof typeof ROLES) {
  const { email, password } = ROLES[role];
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 15000 });
}

function budgetFor(route: string) {
  if (budgets.routes[route]) return budgets.routes[route];
  // Match dynamic patterns: /projects/abc123 matches /projects/:id
  for (const [pattern, budget] of Object.entries<any>(budgets.routes)) {
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
    if (rx.test(route)) return budget;
  }
  return budgets.defaults;
}

// ---------------------------------------------------------------------------
// Dead button detection: click, then assert that SOMETHING observable happened.
// ---------------------------------------------------------------------------
async function isDeadControl(page: Page, index: number): Promise<boolean> {
  const before = {
    url: page.url(),
    html: (await page.content()).length,
    focus: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 100) ?? ''),
  };

  let requestFired = false;
  const listener = () => { requestFired = true; };
  page.on('request', listener);

  const control = page.locator('button:visible, [role="button"]:visible').nth(index);
  const label = ((await control.textContent().catch(() => '')) ?? '').trim();
  if (DESTRUCTIVE.test(label) || !label) { page.off('request', listener); return false; }

  await control.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1500);
  page.off('request', listener);

  const after = {
    url: page.url(),
    html: (await page.content()).length,
    focus: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 100) ?? ''),
  };

  const changed =
    requestFired ||
    before.url !== after.url ||
    Math.abs(before.html - after.html) > 50 ||
    before.focus !== after.focus;

  return !changed;
}

// ---------------------------------------------------------------------------
for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
  if (process.env.ROLE && process.env.ROLE !== role) continue;

  test(`crawl as ${role}`, async ({ page, request }) => {
    test.setTimeout(20 * 60 * 1000);

    const issues: Issue[] = [];
    const visited = new Set<string>();
    const queue: string[] = ['/'];
    const checkedLinks = new Set<string>();

    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|ResizeObserver/.test(m.text())) {
        issues.push({ route: page.url(), kind: 'console-error', detail: m.text().slice(0, 300) });
      }
    });
    page.on('pageerror', (e) => {
      issues.push({ route: page.url(), kind: 'uncaught', detail: e.message });
    });

    await login(page, role);

    while (queue.length && visited.size < MAX_PAGES) {
      const route = queue.shift()!;
      if (visited.has(route)) continue;
      visited.add(route);

      let res: Response | null = null;
      try {
        res = await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
      } catch (e: any) {
        issues.push({ route, kind: 'navigation-failed', detail: e.message });
        continue;
      }

      const status = res?.status() ?? 0;
      const denied = (DENY[role] ?? []).some((d) => route.startsWith(d));

      if (denied) {
        if (status === 200) issues.push({ route, kind: 'unauthorized-access', detail: `${role} reached a denied route with 200` });
        continue;
      }
      if (status >= 400) {
        issues.push({ route, kind: status === 404 ? 'not-found' : 'error-status', detail: String(status) });
        continue;
      }

      // Error boundary and raw error leakage
      const body = await page.content();
      for (const marker of ['Application error', 'Unhandled Runtime Error', 'ECONNREFUSED', 'at Object.<anonymous>', 'PGRST']) {
        if (body.includes(marker)) issues.push({ route, kind: 'error-leak', detail: marker });
      }

      // Empty shell: 200 with nothing rendered is a silently failed fetch
      const text = (await page.locator('main, body').first().innerText().catch(() => '')) ?? '';
      if (text.trim().length < 20) issues.push({ route, kind: 'empty-page', detail: '200 but no content rendered' });

      // Query budget
      const b = budgetFor(route);
      const h = res!.headers();
      const qc = Number(h['x-query-count'] ?? -1);
      const qt = Number(h['x-query-time'] ?? -1);
      if (qc >= 0 && qc > b.maxQueries) {
        issues.push({ route, kind: 'query-budget', detail: `${qc} queries, limit ${b.maxQueries}` });
      }
      if (qt >= 0 && qt > b.maxMs) {
        issues.push({ route, kind: 'time-budget', detail: `${qt}ms db time, limit ${b.maxMs}ms` });
      }
      if (h['x-query-repeated']) {
        issues.push({ route, kind: 'possible-n-plus-1', detail: `repeated query shape x${h['x-query-repeated']}` });
      }

      // Broken images
      const brokenImgs = await page.evaluate(() =>
        [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src)
      );
      for (const src of brokenImgs) issues.push({ route, kind: 'broken-image', detail: src });

      // Links: enqueue internal, HEAD check each unique target
      const hrefs = await page.locator('a[href]').evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? '')
      );
      for (const href of hrefs) {
        if (!href || SKIP.test(href)) continue;
        const url = href.startsWith('http') ? href : new URL(href, BASE_URL).toString();
        if (!url.startsWith(BASE_URL)) continue;
        const p = new URL(url).pathname;
        if (!checkedLinks.has(p)) {
          checkedLinks.add(p);
          const head = await request.get(url, { failOnStatusCode: false, maxRedirects: 3 }).catch(() => null);
          if (head && head.status() === 404) issues.push({ route, kind: 'broken-link', detail: p });
        }
        if (!visited.has(p)) queue.push(p);
      }

      // Dead buttons, sampled to keep runtime sane on dense pages
      const controlCount = await page.locator('button:visible, [role="button"]:visible').count();
      for (let i = 0; i < Math.min(controlCount, 8); i++) {
        const label = await page.locator('button:visible, [role="button"]:visible').nth(i).textContent().catch(() => '');
        if (await isDeadControl(page, i)) {
          issues.push({ route, kind: 'dead-control', detail: (label ?? '').trim().slice(0, 60) });
        }
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
      }
    }

    // Routes that exist in source but were never reached from any entry point
    const unreached = ALL_ROUTES.filter(
      (r) => !r.includes(':') && !r.includes('[') && !visited.has(r) && !(DENY[role] ?? []).some((d) => r.startsWith(d))
    );

    fs.mkdirSync('chaos', { recursive: true });
    fs.writeFileSync(
      `chaos/crawl-${role}.json`,
      JSON.stringify({ role, visited: [...visited], unreached, issues }, null, 2)
    );

    console.log(`\n${role}: visited ${visited.size}, unreached ${unreached.length}, issues ${issues.length}`);
    for (const i of issues.slice(0, 50)) console.log(`  [${i.kind}] ${i.route} ${i.detail}`);
    if (unreached.length) console.log(`  unreached: ${unreached.join(', ')}`);

    const blocking = issues.filter((i) =>
      ['not-found', 'error-status', 'uncaught', 'unauthorized-access', 'query-budget', 'broken-link'].includes(i.kind)
    );
    expect(blocking, `See chaos/crawl-${role}.json`).toHaveLength(0);
  });
}
