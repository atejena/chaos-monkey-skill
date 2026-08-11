/**
 * Mode guard. Enforces the capability matrix at runtime.
 *
 * The reason this exists as code rather than as a note in a document: a warning printed
 * during a long run gets scrolled past, and "remember not to run the monkey against prod"
 * is a rule that works right up until the one time it does not. So disallowed capabilities
 * throw rather than warn.
 *
 * Usage:
 *   import { guard, mode, abortController } from './mode-guard';
 *   guard('randomMonkey');           // throws in production
 *   guard('writeFuzz', { tenant });  // throws in production unless tenant is the canary
 */

export type Mode = 'local' | 'staging' | 'production';

export const mode: Mode = (process.env.CHAOS_MODE as Mode) ?? 'local';

const PROD_HOST = process.env.PROD_HOST ?? '';
const BASE_URL = process.env.BASE_URL ?? '';
const SAFE_HOST = /localhost|127\.0\.0\.1|staging|preview|\.test|\.local/;

export type Capability =
  | 'read'
  | 'measure'
  | 'crawl'
  | 'deadControlCheck'
  | 'happyPathFlow'
  | 'writeFuzz'
  | 'isolationProbe'
  | 'stateMachineProbe'
  | 'concurrencyProbe'
  | 'fileUploadAbuse'
  | 'destructive'
  | 'randomMonkey'
  | 'amplificationProbe'
  | 'sustainedLoad'
  | 'authBruteForce'
  | 'serverFailureInjection'
  | 'schemaMutation';

type Rule = 'allow' | 'deny' | 'restricted';

const MATRIX: Record<Capability, Record<Mode, Rule>> = {
  read:                    { local: 'allow', staging: 'allow', production: 'restricted' },
  measure:                 { local: 'allow', staging: 'allow', production: 'allow' },
  crawl:                   { local: 'allow', staging: 'allow', production: 'restricted' },
  deadControlCheck:        { local: 'allow', staging: 'allow', production: 'restricted' },
  happyPathFlow:           { local: 'allow', staging: 'allow', production: 'restricted' },
  writeFuzz:               { local: 'allow', staging: 'allow', production: 'restricted' },
  isolationProbe:          { local: 'allow', staging: 'allow', production: 'restricted' },
  stateMachineProbe:       { local: 'allow', staging: 'allow', production: 'restricted' },
  concurrencyProbe:        { local: 'allow', staging: 'allow', production: 'restricted' },
  fileUploadAbuse:         { local: 'allow', staging: 'allow', production: 'restricted' },
  destructive:             { local: 'allow', staging: 'allow', production: 'deny' },
  randomMonkey:            { local: 'allow', staging: 'allow', production: 'deny' },
  amplificationProbe:      { local: 'allow', staging: 'allow', production: 'restricted' },
  sustainedLoad:           { local: 'allow', staging: 'restricted', production: 'restricted' },
  authBruteForce:          { local: 'allow', staging: 'allow', production: 'restricted' },
  serverFailureInjection:  { local: 'allow', staging: 'allow', production: 'deny' },
  schemaMutation:          { local: 'allow', staging: 'allow', production: 'deny' },
};

// Restricted capabilities require these preconditions in production.
const PROD_REQUIREMENTS: Partial<Record<Capability, string[]>> = {
  read:               ['CHAOS_SYNTHETIC_USER'],
  crawl:              ['CHAOS_SYNTHETIC_USER', 'CHAOS_RATE_LIMIT'],
  deadControlCheck:   ['CHAOS_SYNTHETIC_USER'],
  happyPathFlow:      ['CHAOS_SYNTHETIC_USER', 'CHAOS_SYNTHETIC_TAG'],
  writeFuzz:          ['CHAOS_CANARY_TENANT', 'CHAOS_SYNTHETIC_TAG'],
  isolationProbe:     ['CHAOS_CANARY_TENANT', 'CHAOS_CANARY_TENANT_B'],
  stateMachineProbe:  ['CHAOS_CANARY_TENANT', 'CHAOS_SYNTHETIC_TAG'],
  concurrencyProbe:   ['CHAOS_CANARY_TENANT'],
  fileUploadAbuse:    ['CHAOS_CANARY_TENANT', 'CHAOS_SYNTHETIC_TAG'],
  amplificationProbe: ['CHAOS_SYNTHETIC_USER', 'CHAOS_WINDOW_CONFIRMED', 'CHAOS_BASELINE_CAPTURED'],
  sustainedLoad:      ['CHAOS_WINDOW_CONFIRMED', 'CHAOS_OPS_NOTIFIED', 'CHAOS_KILL_SWITCH'],
  authBruteForce:     ['CHAOS_SYNTHETIC_USER'],
};

export class ModeViolation extends Error {}

let halted = false;
let haltReason = '';

export function halt(reason: string) {
  halted = true;
  haltReason = reason;
  console.error(`\n🛑 CHAOS RUN HALTED: ${reason}\n`);
}

export function isHalted() { return halted; }

export function guard(cap: Capability, ctx: { tenant?: string } = {}) {
  if (halted) throw new ModeViolation(`Run halted: ${haltReason}`);

  // Sanity: mode must match the target.
  if (mode !== 'production' && BASE_URL && !SAFE_HOST.test(BASE_URL)) {
    throw new ModeViolation(
      `CHAOS_MODE=${mode} but BASE_URL=${BASE_URL} does not look local or staging. ` +
      `Set CHAOS_MODE=production deliberately, or fix the URL.`
    );
  }
  if (mode === 'production' && PROD_HOST && !BASE_URL.includes(PROD_HOST)) {
    throw new ModeViolation(`CHAOS_MODE=production but BASE_URL does not match PROD_HOST.`);
  }

  const rule = MATRIX[cap][mode];

  if (rule === 'deny') {
    throw new ModeViolation(
      `Capability "${cap}" is not permitted in ${mode} mode. This is deliberate and not ` +
      `overridable. Run it in staging instead.`
    );
  }

  if (rule === 'restricted') {
    const required = PROD_REQUIREMENTS[cap] ?? [];
    const missing = required.filter((k) => !process.env[k]);
    if (mode === 'production' && missing.length) {
      throw new ModeViolation(
        `Capability "${cap}" in production requires: ${missing.join(', ')}. ` +
        `See references/environments.md for what each precondition means.`
      );
    }
    if (mode === 'production' && ctx.tenant && ctx.tenant !== process.env.CHAOS_CANARY_TENANT
        && ctx.tenant !== process.env.CHAOS_CANARY_TENANT_B) {
      throw new ModeViolation(
        `Refusing "${cap}" against tenant ${ctx.tenant}. Production writes are restricted ` +
        `to the canary tenants.`
      );
    }
  }
}

/**
 * Abort watcher for production runs. Poll health signals and halt on breach.
 * Wire checkFn to whatever telemetry exists: an APM API, a health endpoint, or SQL.
 */
export async function watchAbortConditions(
  checkFn: () => Promise<{ errorRate: number; p95Ms: number; poolPct: number; alerts: number }>,
  baseline: { errorRate: number; p95Ms: number },
  intervalMs = 10000
) {
  if (mode !== 'production') return () => {};
  const timer = setInterval(async () => {
    try {
      const s = await checkFn();
      if (s.errorRate > baseline.errorRate + 0.005) return halt(`error rate ${(s.errorRate * 100).toFixed(2)}% above baseline`);
      if (s.p95Ms > baseline.p95Ms * 2) return halt(`p95 ${s.p95Ms}ms is 2x baseline ${baseline.p95Ms}ms`);
      if (s.poolPct > 0.7) return halt(`connection pool at ${(s.poolPct * 100).toFixed(0)}%`);
      if (s.alerts > 0) return halt(`${s.alerts} monitoring alert(s) firing`);
    } catch (e: any) {
      halt(`abort watcher could not read telemetry: ${e.message}`);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Tag every record created so it is filterable and removable. */
export function syntheticTag() {
  return process.env.CHAOS_SYNTHETIC_TAG ?? 'CHAOS';
}

export function syntheticName(base: string) {
  return `${syntheticTag()}-${base}-${Date.now()}`;
}
