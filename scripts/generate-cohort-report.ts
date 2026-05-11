/**
 * scripts/generate-cohort-report.ts
 *
 * Generate a Markdown founding-partner cohort report from a tenant's
 * activation data over a date range. Optionally compares against a
 * direct-signup baseline cohort supplied by the integrator as CSV.
 *
 * Usage:
 *   npx tsx scripts/generate-cohort-report.ts \
 *     --tenant-id <uuid> \
 *     --from 2026-05-06 \
 *     --to   2026-06-05 \
 *     [--baseline-csv ./baseline.csv] \
 *     [--out ./report.md]
 *
 * Baseline CSV format (header required):
 *   external_user_id,signup_at,first_call_at
 *   user_42,2026-05-04T10:00:00Z,2026-05-04T11:30:00Z
 *
 * If --baseline-csv is omitted the report will still render but will
 * note that activation rates cannot be compared against direct signup.
 *
 * Report sections (in order):
 *   1. Headline numbers (signups, key handoffs, 24h activations, 7d activations)
 *   2. Funnel (signup → handoff → first call)
 *   3. Time-to-first-call distribution (P50 / P90 / P99)
 *   4. Per-day breakdown
 *   5. Baseline comparison (if supplied)
 *   6. Methodology
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, between, eq } from 'drizzle-orm';
import { db } from '../src/server/db/index';
import { activations, signup_jobs, tenants } from '../src/server/db/schema';

type Args = {
  tenantId: string;
  from: Date;
  to: Date;
  baselineCsv?: string;
  outPath: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const tenantId = get('tenant-id');
  const from = get('from');
  const to = get('to');
  if (!tenantId || !from || !to) {
    console.error(
      'Usage: npx tsx scripts/generate-cohort-report.ts --tenant-id <uuid> --from YYYY-MM-DD --to YYYY-MM-DD [--baseline-csv path] [--out path]',
    );
    process.exit(2);
  }

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T23:59:59Z`);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    console.error('Invalid --from / --to date');
    process.exit(2);
  }

  return {
    tenantId,
    from: fromDate,
    to: toDate,
    baselineCsv: get('baseline-csv'),
    outPath: get('out') ?? resolve(process.cwd(), 'cohort-report.md'),
  };
}

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

type BaselineRow = {
  externalUserId: string;
  signupAt: Date;
  firstCallAt: Date | null;
};

function parseBaseline(path: string): BaselineRow[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.trim().split('\n');
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(',').map((s) => s.trim());
  const idx = {
    extUser: cols.indexOf('external_user_id'),
    signup: cols.indexOf('signup_at'),
    firstCall: cols.indexOf('first_call_at'),
  };
  if (idx.extUser < 0 || idx.signup < 0 || idx.firstCall < 0) {
    throw new Error(
      'Baseline CSV must have headers: external_user_id, signup_at, first_call_at',
    );
  }
  const rows: BaselineRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    const externalUserId = parts[idx.extUser]?.trim() ?? '';
    const signupAtStr = parts[idx.signup]?.trim() ?? '';
    const firstCallAtStr = parts[idx.firstCall]?.trim() ?? '';
    if (!externalUserId || !signupAtStr) continue;
    rows.push({
      externalUserId,
      signupAt: new Date(signupAtStr),
      firstCallAt: firstCallAtStr ? new Date(firstCallAtStr) : null,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, args.tenantId))
    .limit(1);
  if (!tenant) {
    console.error(`Tenant ${args.tenantId} not found`);
    process.exit(1);
  }

  const signupRows = await db
    .select()
    .from(signup_jobs)
    .where(
      and(
        eq(signup_jobs.tenant_id, args.tenantId),
        between(signup_jobs.created_at, args.from, args.to),
      ),
    );

  const activationRows = await db
    .select()
    .from(activations)
    .where(
      and(
        eq(activations.tenant_id, args.tenantId),
        between(activations.occurred_at, args.from, args.to),
      ),
    );

  const totalSignups = signupRows.length;
  const completedSignups = signupRows.filter((r) => r.status === 'complete').length;
  const handoffs = signupRows.filter((r) => r.handoff_at !== null).length;
  const firstCallSignupIds = new Set(
    activationRows
      .filter((a) => a.event_name === 'authenticated_api_call_succeeded')
      .map((a) => a.signup_id),
  );
  const within24h = activationRows.filter((a) => a.is_24h).length;
  const within7d = activationRows.filter((a) => a.is_7d).length;

  // Time-to-first-call distribution: per signup, the smallest occurred_at - handoff_at.
  const handoffById = new Map(signupRows.map((r) => [r.id, r.handoff_at]));
  const ttfcMs: number[] = [];
  for (const sid of firstCallSignupIds) {
    const handoff = handoffById.get(sid) ?? null;
    if (!handoff) continue;
    const events = activationRows
      .filter((a) => a.signup_id === sid && a.event_name === 'authenticated_api_call_succeeded')
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    const first = events[0];
    if (!first) continue;
    const elapsed = first.occurred_at.getTime() - handoff.getTime();
    if (elapsed >= 0) ttfcMs.push(elapsed);
  }
  ttfcMs.sort((a, b) => a - b);
  const p50 = quantile(ttfcMs, 0.5);
  const p90 = quantile(ttfcMs, 0.9);
  const p99 = quantile(ttfcMs, 0.99);

  // Per-day breakdown.
  const byDay = new Map<string, { signups: number; activations24h: number }>();
  for (const r of signupRows) {
    if (!r.created_at) continue;
    const day = r.created_at.toISOString().slice(0, 10);
    const e = byDay.get(day) ?? { signups: 0, activations24h: 0 };
    e.signups += 1;
    byDay.set(day, e);
  }
  for (const a of activationRows) {
    if (!a.is_24h) continue;
    const day = a.occurred_at.toISOString().slice(0, 10);
    const e = byDay.get(day) ?? { signups: 0, activations24h: 0 };
    e.activations24h += 1;
    byDay.set(day, e);
  }
  const dayKeys = [...byDay.keys()].sort();

  // Baseline comparison.
  let baselineSection = '';
  if (args.baselineCsv) {
    if (!existsSync(args.baselineCsv)) {
      baselineSection = `\n## 5. Baseline comparison\n\n_Baseline file not found at \`${args.baselineCsv}\`._\n`;
    } else {
      const baseline = parseBaseline(args.baselineCsv);
      const baselineCount = baseline.length;
      const baselineActivated24h = baseline.filter((b) => {
        if (!b.firstCallAt) return false;
        const elapsed = b.firstCallAt.getTime() - b.signupAt.getTime();
        return elapsed >= 0 && elapsed <= 24 * 60 * 60 * 1000;
      }).length;
      baselineSection =
        `\n## 5. Baseline comparison (vs. direct signup)\n\n` +
        `| Cohort | Signups | 24h activations | 24h activation rate |\n` +
        `|---|---:|---:|---:|\n` +
        `| Agent-onboarded (via Relay) | ${totalSignups} | ${within24h} | ${pct(within24h, totalSignups)} |\n` +
        `| Direct (baseline) | ${baselineCount} | ${baselineActivated24h} | ${pct(baselineActivated24h, baselineCount)} |\n`;
    }
  } else {
    baselineSection =
      `\n## 5. Baseline comparison\n\n` +
      `_No baseline CSV supplied. To enable a meaningful comparison, export your direct-signup cohort over the same window with columns \`external_user_id,signup_at,first_call_at\` and re-run with \`--baseline-csv\`. Without a baseline this report only shows agent-attributed numbers in isolation, which is necessary but insufficient for a renewal decision._\n`;
  }

  const md = `# Founding partner cohort report

**Tenant:** ${tenant.name} (\`${tenant.slug}\`)
**Window:** ${args.from.toISOString().slice(0, 10)} → ${args.to.toISOString().slice(0, 10)}
**Generated:** ${new Date().toISOString()}

---

## 1. Headline

| Metric | Value |
|---|---:|
| Agent-attributed signups | ${totalSignups} |
| Completed signups | ${completedSignups} |
| Key handoffs delivered | ${handoffs} |
| Signups with ≥1 first authenticated call | ${firstCallSignupIds.size} |
| Activations within 24h of handoff | ${within24h} |
| Activations within 7d of handoff | ${within7d} |
| 24h activation rate | ${pct(within24h, totalSignups)} |
| 7d activation rate | ${pct(within7d, totalSignups)} |

## 2. Funnel

| Stage | Count | Conversion from previous |
|---|---:|---:|
| Signup created | ${totalSignups} | — |
| Signup completed | ${completedSignups} | ${pct(completedSignups, totalSignups)} |
| Key handoff delivered | ${handoffs} | ${pct(handoffs, completedSignups)} |
| Reached first authenticated call | ${firstCallSignupIds.size} | ${pct(firstCallSignupIds.size, handoffs)} |
| Activated within 24h | ${within24h} | ${pct(within24h, firstCallSignupIds.size)} |

## 3. Time-to-first-call

| Percentile | Time |
|---|---:|
| P50 | ${fmtMs(p50)} |
| P90 | ${fmtMs(p90)} |
| P99 | ${fmtMs(p99)} |
| Sample size | ${ttfcMs.length} |

## 4. Per-day breakdown

| Day | Signups | 24h activations |
|---|---:|---:|
${dayKeys.length === 0 ? '| _no activity in window_ | — | — |' : dayKeys.map((d) => `| ${d} | ${byDay.get(d)!.signups} | ${byDay.get(d)!.activations24h} |`).join('\n')}
${baselineSection}
## 6. Methodology

- **Activation** = first successful \`authenticated_api_call_succeeded\` event, reported by your middleware via \`@cumulus/track\`, occurring within 24 hours of the genuine key handoff (\`signup_jobs.handoff_at\`).
- The 7d window is reported alongside as context.
- Test traffic, healthchecks, and docs/playground pings are excluded if your middleware filters them before calling \`relay.track\`.
- Idempotency: dedupe on \`(tenant, idempotency_key)\` — duplicate events are no-ops.
- Baseline is YOUR direct-signup cohort supplied as CSV. Without a baseline, agent-cohort numbers cannot be compared against your normal funnel.
`;

  writeFileSync(args.outPath, md, 'utf8');
  console.log(`Report written to ${args.outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
