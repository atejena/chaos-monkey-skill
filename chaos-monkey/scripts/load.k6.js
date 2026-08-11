/**
 * Load scenarios. Run against staging with medium or large seed data.
 *
 *   k6 run -e BASE_URL=https://staging.app -e TOKEN=<jwt> load.k6.js
 *   k6 run --tag scenario=abuse load.k6.js
 *
 * The scenario that matters most is `singleUserAbuse`. Realistic load tells you whether
 * the app scales. Abuse load tells you whether one customer can take it down, which is
 * the question that actually keeps people up at night.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const queryCount = new Trend('db_query_count');
const rateLimited = new Rate('rate_limited');

export const options = {
  scenarios: {
    realistic: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '3m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      exec: 'normalFlow',
    },
    singleUserAbuse: {
      executor: 'constant-vus',
      vus: 1,
      duration: '2m',
      startTime: '5m',
      exec: 'abuse',
    },
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 200 },
        { duration: '1m', target: 200 },
        { duration: '30s', target: 0 },
      ],
      startTime: '8m',
      exec: 'normalFlow',
    },
  },
  thresholds: {
    'http_req_duration{scenario:realistic}': ['p(95)<1500'],
    'http_req_failed{scenario:realistic}': ['rate<0.01'],
    // Abuse traffic must be rejected, not served slowly. If this fails, one user can
    // degrade the app for everyone.
    'rate_limited{scenario:singleUserAbuse}': ['rate>0.5'],
    'http_req_duration{scenario:spike}': ['p(95)<4000'],
  },
};

function track(res) {
  const qc = res.headers['X-Query-Count'];
  if (qc) queryCount.add(Number(qc));
  rateLimited.add(res.status === 429);
  return res;
}

export function normalFlow() {
  track(http.get(`${BASE}/api/projects?limit=25`, { headers }));
  sleep(1 + Math.random() * 2);
  const list = http.get(`${BASE}/api/projects?limit=25`, { headers });
  const projects = list.json('data') || [];
  if (projects.length) {
    const id = projects[Math.floor(Math.random() * projects.length)].id;
    check(track(http.get(`${BASE}/api/projects/${id}`, { headers })), { 'detail 200': (r) => r.status === 200 });
    sleep(1);
    track(http.get(`${BASE}/api/projects/${id}/change-orders`, { headers }));
  }
  sleep(2 + Math.random() * 3);
}

/**
 * Worst amplification vectors found during exploration. Replace these with the actual
 * worst offenders discovered in the query-load pass; these are the usual suspects.
 */
export function abuse() {
  const vectors = [
    `/api/projects?limit=1000000`,
    `/api/projects?offset=5000000&limit=100`,
    `/api/projects?select=*,line_items(*,attachments(*,versions(*)))`,
    `/api/search?q=a`,
    `/api/reports/summary?from=1970-01-01&to=2099-12-31`,
    `/api/projects?sort=computed_total&order=desc`,
    `/api/export?format=csv&all=true`,
  ];
  for (const v of vectors) {
    const res = track(http.get(`${BASE}${v}`, { headers, timeout: '60s' }));
    check(res, {
      'rejected or capped': (r) => r.status === 429 || r.status === 400 || r.timings.duration < 3000,
    });
  }
}
