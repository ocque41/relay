/**
 * /dev/analytics — integrator value-proof dashboard.
 *
 * Every integrator pays per billable action (signup / reveal / rotate /
 * delete). The numbers on this page are the proof of value: how many
 * end-users the agent channel is actually landing on the integrator's
 * API, what it's costing, and how latency is trending.
 *
 * Sections:
 *   - Period snapshot (total signups delivered, unique users, success rate)
 *   - Delivered signups by day (SVG sparkline, last 30 days)
 *   - Quota utilization (bar)
 *   - Overage spend this period
 *   - Top providers by delivered count (last 30 days)
 *   - Latency P50 / P95 per action (last 24 h, from action_invocations)
 *   - Error rate last 24 h
 *   - Scale benchmark P50 / P95 per stage (Scale tenants only)
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, countDistinct, desc, eq, gte, sql } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import {
  action_invocations,
  actions,
  plan_catalog,
  signup_jobs,
  tenant_plan_features,
  tenant_quota_state,
  tenant_subscriptions,
} from '@/src/server/db/schema';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';
import { Stat, Stats } from '@/app/components/Stat';

function pct(n: number, d: number): string {
  if (d <= 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Build a 30-bucket daily count array from a list of {day, count} rows. */
function dailyBuckets(
  rows: Array<{ day: string | Date; count: number | string }>,
  days: number,
): Array<{ day: string; count: number }> {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    byDay.set(key, Number(r.count));
  }
  const out: Array<{ day: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}

/** Inline SVG sparkline with no external dep. */
function Sparkline({ data }: { data: Array<{ day: string; count: number }> }) {
  const w = 480;
  const h = 72;
  const pad = 6;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const points = data
    .map((d, i) => {
      const x = pad + i * step;
      const y = h - pad - (d.count / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="Delivered signups by day"
      style={{ display: 'block' }}
    >
      <polyline
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={1.5}
        points={points}
      />
      {data.map((d, i) => {
        const x = pad + i * step;
        const y = h - pad - (d.count / max) * (h - pad * 2);
        return (
          <circle
            key={d.day}
            cx={x}
            cy={y}
            r={i === data.length - 1 ? 2.5 : 1.5}
            fill="var(--color-ink)"
          />
        );
      })}
    </svg>
  );
}

export default async function DevAnalyticsPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    subRows,
    quotaRows,
    planRows,
    featureRows,
    totals30d,
    uniqUsers30d,
    dailyRaw,
    topProvidersRaw,
    latencyRaw,
    error24hRows,
    scaleRaw,
  ] = await Promise.all([
    db
      .select({
        plan: tenant_subscriptions.plan,
        status: tenant_subscriptions.status,
      })
      .from(tenant_subscriptions)
      .where(eq(tenant_subscriptions.tenant_id, tenantId))
      .orderBy(desc(tenant_subscriptions.created_at))
      .limit(1),

    db
      .select()
      .from(tenant_quota_state)
      .where(eq(tenant_quota_state.tenant_id, tenantId))
      .limit(1),

    db.select().from(plan_catalog),

    db
      .select({ features: tenant_plan_features.features })
      .from(tenant_plan_features)
      .where(eq(tenant_plan_features.tenant_id, tenantId))
      .limit(1),

    db
      .select({
        total: sql<number>`count(*)::int`,
        complete: sql<number>`sum(case when ${signup_jobs.status} = 'complete' then 1 else 0 end)::int`,
        failed: sql<number>`sum(case when ${signup_jobs.status} = 'failed' then 1 else 0 end)::int`,
      })
      .from(signup_jobs)
      .where(
        and(
          eq(signup_jobs.tenant_id, tenantId),
          gte(signup_jobs.created_at, thirtyDaysAgo),
        ),
      ),

    db
      .select({ uniq: countDistinct(signup_jobs.user_id) })
      .from(signup_jobs)
      .where(
        and(
          eq(signup_jobs.tenant_id, tenantId),
          eq(signup_jobs.status, 'complete'),
          gte(signup_jobs.created_at, thirtyDaysAgo),
        ),
      ),

    db.execute(sql`
      SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS count
      FROM signup_jobs
      WHERE tenant_id = ${tenantId}
        AND status = 'complete'
        AND created_at >= ${thirtyDaysAgo}
      GROUP BY 1
      ORDER BY 1
    `),

    db
      .select({
        provider_slug: signup_jobs.provider_slug,
        count: sql<number>`count(*)::int`,
      })
      .from(signup_jobs)
      .where(
        and(
          eq(signup_jobs.tenant_id, tenantId),
          eq(signup_jobs.status, 'complete'),
          gte(signup_jobs.created_at, thirtyDaysAgo),
        ),
      )
      .groupBy(signup_jobs.provider_slug)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(10),

    db.execute(sql`
      SELECT a.slug,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ai.latency_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY ai.latency_ms)::int AS p95,
        count(*)::int AS n
      FROM action_invocations ai
      JOIN actions a ON a.id = ai.action_id
      WHERE ai.tenant_id = ${tenantId}
        AND ai.status = 'succeeded'
        AND ai.latency_ms IS NOT NULL
        AND ai.created_at >= ${dayAgo}
      GROUP BY a.slug
      ORDER BY n DESC
      LIMIT 10
    `),

    db
      .select({
        total: sql<number>`count(*)::int`,
        failed: sql<number>`sum(case when ${action_invocations.status} in ('failed','unknown') then 1 else 0 end)::int`,
      })
      .from(action_invocations)
      .where(
        and(
          eq(action_invocations.tenant_id, tenantId),
          gte(action_invocations.created_at, dayAgo),
        ),
      ),

    db.execute(sql`
      SELECT stage,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95,
        count(*)::int AS n
      FROM scale_benchmark_samples
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${dayAgo}
      GROUP BY stage
    `),
  ]);

  const subRow = subRows[0] ?? null;
  const quotaRow = quotaRows[0] ?? null;
  const plan = planRows.find((p) => p.id === (subRow?.plan ?? 'founders'));
  const featureBag = (featureRows[0]?.features as Record<string, unknown> | undefined) ?? {};
  const isScale = featureBag.scale_e2e_benchmark === true;

  const totals = totals30d[0] ?? { total: 0, complete: 0, failed: 0 };
  const uniqueUsers = Number(uniqUsers30d[0]?.uniq ?? 0);
  const successRate = pct(Number(totals.complete), Number(totals.total));

  type DailyRow = { day: string; count: number | string };
  const daily = dailyBuckets(
    ((dailyRaw as unknown as { rows?: DailyRow[] }).rows ?? []) as DailyRow[],
    30,
  );

  const includedTotal = plan?.included_actions ?? 0;
  const includedRemaining = quotaRow?.included_remaining ?? 0;
  const overageCount = quotaRow?.overage_count ?? 0;
  const overagePriceCents = plan?.overage_price_cents ?? 0;
  const overageSpendCents = overageCount * overagePriceCents;
  const utilizationPct =
    includedTotal > 0
      ? Math.min(
          100,
          Math.round(((includedTotal - includedRemaining) / includedTotal) * 100),
        )
      : 0;

  type LatencyRow = { slug: string; p50: number; p95: number; n: number };
  const latency: LatencyRow[] =
    ((latencyRaw as unknown as { rows?: LatencyRow[] }).rows ?? []) as LatencyRow[];

  const err = error24hRows[0] ?? { total: 0, failed: 0 };

  type ScaleRow = { stage: string; p50: number; p95: number; n: number };
  const scale: ScaleRow[] =
    ((scaleRaw as unknown as { rows?: ScaleRow[] }).rows ?? []) as ScaleRow[];

  return (
    <>
      <header className="head">
        <div>
          <Kicker>08 — Analytics</Kicker>
          <H1>
            Signups,
            <br />
            users, spend.
          </H1>
        </div>
        <div className="headmeta">
          <b>{subRow ? subRow.plan : 'no plan'}</b>
          <br />
          last 30 days
        </div>
      </header>

      <Stats>
        <Stat label="Delivered 30d" value={fmt(Number(totals.complete))} sub={`${successRate} success`} />
        <Stat label="Unique users 30d" value={fmt(uniqueUsers)} sub="API-key-holding accounts" />
        <Stat
          label="Failed 30d"
          value={fmt(Number(totals.failed))}
          sub={totals.total === 0 ? '—' : pct(Number(totals.failed), Number(totals.total))}
        />
      </Stats>

      <Row label="Delivered signups (30d)">
        {daily.every((d) => d.count === 0) ? (
          <span className="quota-label">No delivered signups yet in this window.</span>
        ) : (
          <Sparkline data={daily} />
        )}
      </Row>

      {includedTotal > 0 && (
        <Row label="Quota utilization">
          <div
            className="quota-bar"
            aria-label="Included action quota utilization"
            role="progressbar"
            aria-valuenow={utilizationPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="quota-bar-fill" style={{ width: `${utilizationPct}%` }} />
          </div>
          <span className="quota-label">
            {utilizationPct}% used · {fmt(includedRemaining)} of {fmt(includedTotal)} actions remaining
          </span>
        </Row>
      )}

      <Stats>
        <Stat label="Overage actions" value={fmt(overageCount)} sub="this period" />
        <Stat label="Overage rate" value={money(overagePriceCents)} sub="per action" />
        <Stat label="Overage spend" value={money(overageSpendCents)} sub="this period" />
      </Stats>

      <Row label="Top providers (30d)">
        {topProvidersRaw.length === 0 ? (
          <span className="quota-label">No delivered signups yet.</span>
        ) : (
          <table className="metrics-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th style={{ textAlign: 'right' }}>Delivered</th>
              </tr>
            </thead>
            <tbody>
              {topProvidersRaw.map((r) => (
                <tr key={r.provider_slug}>
                  <td>{r.provider_slug}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(Number(r.count))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Row>

      <Row label="Action latency (24h, P50 / P95 ms)">
        {latency.length === 0 ? (
          <span className="quota-label">No successful action invocations in the last 24h.</span>
        ) : (
          <table className="metrics-table">
            <thead>
              <tr>
                <th>Slug</th>
                <th style={{ textAlign: 'right' }}>P50</th>
                <th style={{ textAlign: 'right' }}>P95</th>
                <th style={{ textAlign: 'right' }}>n</th>
              </tr>
            </thead>
            <tbody>
              {latency.map((r) => (
                <tr key={r.slug}>
                  <td>{r.slug}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(Number(r.p50))}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(Number(r.p95))}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(Number(r.n))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Row>

      <Row label="Action error rate (24h)">
        <span className="quota-label">
          {pct(Number(err.failed ?? 0), Number(err.total ?? 0))} failed of{' '}
          {fmt(Number(err.total ?? 0))} invocations
        </span>
      </Row>

      {isScale && (
        <Row label="Scale benchmark (24h, Relay-internal P50/P95 ms)">
          {scale.length === 0 ? (
            <span className="quota-label">No samples in the last 24 h yet — cron writes every 5 min.</span>
          ) : (
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th style={{ textAlign: 'right' }}>P50</th>
                  <th style={{ textAlign: 'right' }}>P95</th>
                  <th style={{ textAlign: 'right' }}>Samples</th>
                </tr>
              </thead>
              <tbody>
                {scale.map((r) => (
                  <tr key={r.stage}>
                    <td>{r.stage}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(Number(r.p50))}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(Number(r.p95))}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(Number(r.n))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Row>
      )}
    </>
  );
}
