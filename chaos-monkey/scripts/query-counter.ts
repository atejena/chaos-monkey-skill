/**
 * Per request query instrumentation.
 *
 * This is the highest leverage file in the whole kit. Once every response carries
 * X-Query-Count and X-Query-Time, every functional test becomes a performance test,
 * and N+1 regressions fail the build instead of arriving as a customer complaint.
 *
 * Enable in development, test and staging. Gate it off in production, or keep it on
 * but strip the headers at the edge if you would rather not expose the numbers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type QueryRecord = { sql: string; ms: number; rows?: number };
type RequestStats = { queries: QueryRecord[]; startedAt: number };

export const queryStore = new AsyncLocalStorage<RequestStats>();

export function recordQuery(sql: string, ms: number, rows?: number) {
  const store = queryStore.getStore();
  if (!store) return;
  // Normalize so repeated identical shapes are easy to spot in the report.
  store.queries.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 500), ms, rows });
}

export function summarize(stats: RequestStats) {
  const totalMs = stats.queries.reduce((s, q) => s + q.ms, 0);
  const byShape = new Map<string, number>();
  for (const q of stats.queries) {
    const shape = q.sql.replace(/\$\d+|'[^']*'|\b\d+\b/g, '?');
    byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
  }
  // A shape repeated many times in one request is the N+1 signature.
  const repeated = [...byShape.entries()].filter(([, n]) => n > 3).sort((a, b) => b[1] - a[1]);
  return {
    count: stats.queries.length,
    totalMs: Math.round(totalMs),
    wallMs: Math.round(performance.now() - stats.startedAt),
    slowest: [...stats.queries].sort((a, b) => b.ms - a.ms).slice(0, 3),
    repeatedShapes: repeated.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Next.js middleware / route wrapper
// ---------------------------------------------------------------------------
export function withQueryStats<T extends (...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (...args: any[]) => {
    const stats: RequestStats = { queries: [], startedAt: performance.now() };
    return queryStore.run(stats, async () => {
      const res = await handler(...args);
      const s = summarize(stats);
      const headers = new Headers(res.headers);
      headers.set('X-Query-Count', String(s.count));
      headers.set('X-Query-Time', String(s.totalMs));
      headers.set('X-Wall-Time', String(s.wallMs));
      if (s.repeatedShapes.length) {
        headers.set('X-Query-Repeated', s.repeatedShapes.map(([, n]) => n).join(','));
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    });
  }) as T;
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------
export function instrumentPrisma(prisma: any) {
  prisma.$on('query', (e: any) => recordQuery(e.query, e.duration));
  return prisma;
}

// ---------------------------------------------------------------------------
// node-postgres
// ---------------------------------------------------------------------------
export function instrumentPg(pool: any) {
  const original = pool.query.bind(pool);
  pool.query = async (...args: any[]) => {
    const t = performance.now();
    try {
      const result = await original(...args);
      recordQuery(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '?', performance.now() - t, result?.rowCount);
      return result;
    } catch (err) {
      recordQuery(`FAILED: ${typeof args[0] === 'string' ? args[0] : '?'}`, performance.now() - t);
      throw err;
    }
  };
  return pool;
}

// ---------------------------------------------------------------------------
// Supabase JS. Counts round trips rather than underlying SQL, so pair this with
// pg_stat_statements when hunting a specific N+1.
// ---------------------------------------------------------------------------
export function instrumentSupabase(client: any) {
  for (const method of ['from', 'rpc'] as const) {
    const original = client[method].bind(client);
    client[method] = (...args: any[]) => {
      const builder = original(...args);
      const then = builder.then.bind(builder);
      builder.then = (onFulfilled: any, onRejected: any) => {
        const t = performance.now();
        return then((result: any) => {
          recordQuery(`${method}(${args[0]})`, performance.now() - t, result?.data?.length);
          return onFulfilled?.(result) ?? result;
        }, onRejected);
      };
      return builder;
    };
  }
  return client;
}

/**
 * Playwright side assertion. Pair with budgets.json.
 *
 *   const res = await page.goto('/projects');
 *   assertBudget('/projects', res);
 */
export function readStats(res: { headers(): Record<string, string> }) {
  const h = res.headers();
  return {
    queries: Number(h['x-query-count'] ?? -1),
    queryMs: Number(h['x-query-time'] ?? -1),
    wallMs: Number(h['x-wall-time'] ?? -1),
  };
}
