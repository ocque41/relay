import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';
import { ReserveSprintButton } from '@/app/components/ReserveSprintButton';

export const metadata = {
  title: 'Founding Partner Offer — Relay',
  description:
    '$2,500 prepaid for a 30-day founding-partner sprint. We integrate Relay into your signup/API-key flow, instrument first authenticated API calls, and deliver a day-30 activation cohort report. Renewal at $2,500/month, decided after the report.',
};

const sectionWrap = {
  maxWidth: 880,
  margin: '0 auto',
  padding: '96px 24px 96px',
  display: 'grid',
  gap: 56,
} as const;

const card = {
  border: '1px solid var(--color-rule)',
  borderRadius: 8,
  padding: '24px 26px',
  background: 'var(--color-paper)',
} as const;

const small = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  color: 'var(--color-ink-3)',
} as const;

const body = {
  fontFamily: 'var(--font-body)',
  fontSize: 17,
  lineHeight: 1.65,
  color: 'var(--color-ink-2)',
} as const;

const sectionH = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--color-ink-3)',
  margin: '0 0 16px',
} as const;

export default function PricingPage() {
  return (
    <main style={sectionWrap}>
      <header>
        <Kicker>Founding Partner Offer · Concierge phase</Kicker>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: 'clamp(40px, 5vw, 56px)',
            lineHeight: 1.05,
            letterSpacing: '-0.015em',
            margin: '12px 0 20px',
          }}
        >
          $2,500. Prepaid. 30 days.
        </h1>
        <p style={{ ...body, maxWidth: 720 }}>
          One offer. No tiers, no usage metering during the pilot, no monthly minimum to argue
          about. We integrate Relay into your signup and API-key flow, instrument the first
          authenticated API call from every Relay-issued key, and deliver a day-30 cohort report
          on what your agent-onboarded users actually look like. If the report is worth keeping,
          you renew month-to-month at $2,500. If not, don&rsquo;t.
        </p>
        <div style={{ marginTop: 24 }}>
          <ReserveSprintButton />
        </div>
      </header>

      <section>
        <h2 style={sectionH}>What $2,500 covers</h2>
        <div style={card}>
          <ul style={{ ...body, margin: 0, paddingLeft: 22 }}>
            <li>Concierge integration — webhook + a one-line SDK call in your key middleware.</li>
            <li>30 days of operating the agent-onboarding loop end to end.</li>
            <li>Per-key activation tracking joined to the genuine handoff timestamp.</li>
            <li>Day-30 cohort report (Markdown), with a baseline-cohort comparison if you supply it.</li>
            <li>Operator on-call for the duration of the sprint.</li>
          </ul>
        </div>
      </section>

      <section>
        <h2 style={sectionH}>What renewal looks like</h2>
        <div style={card}>
          <div style={body}>
            $2,500/month, month-to-month, no notice required. The first renewal invoice fires
            after we share the day-30 report and you decide it&rsquo;s worth keeping. We charge
            month-to-month, not annual, because we&rsquo;d rather earn the next month than book
            a year you regret.
          </div>
        </div>
      </section>

      <section>
        <h2 style={sectionH}>Why prepaid, not free</h2>
        <div style={card}>
          <div style={body}>
            Free pilots tell us very little. People who don&rsquo;t pay don&rsquo;t complain,
            don&rsquo;t prioritize the integration, and don&rsquo;t hold us accountable to a
            real timeline. $2,500 is small enough to skip a buying committee in most companies,
            big enough that you actually want value back, and the same on both sides whether or
            not we end up renewing.
          </div>
        </div>
      </section>

      <section>
        <h2 style={sectionH}>Refund / kill terms</h2>
        <div style={card}>
          <div style={body}>
            If we can&rsquo;t complete a workable integration within the first two weeks of the
            sprint, you get a full refund and we walk. After that the $2,500 is non-refundable —
            but the renewal decision is fully yours and there&rsquo;s no notice period.
          </div>
        </div>
      </section>

      <section>
        <h2 style={sectionH}>What this isn&rsquo;t</h2>
        <div style={card}>
          <ul style={{ ...body, margin: 0, paddingLeft: 22 }}>
            <li>Not a self-serve plan. There are no tiers, credit packs, or usage caps to worry about.</li>
            <li>Not a replacement for your auth — Clerk/Auth0/Supabase/your own all stay.</li>
            <li>Not a promise of traffic. We close the agent-onboarding loop; demand still comes from your users.</li>
          </ul>
        </div>
      </section>

      <section>
        <h2 style={sectionH}>Reserve a sprint</h2>
        <div style={{ marginTop: 8 }}>
          <ReserveSprintButton />
        </div>
        <div style={{ ...small, marginTop: 18 }}>
          Or email{' '}
          <a href="mailto:hi@cumulush.com" style={{ color: 'var(--color-ink)' }}>
            hi@cumulush.com
          </a>{' '}
          first.
        </div>
        <div style={{ ...small, marginTop: 6 }}>
          <Link href="/" style={{ color: 'var(--color-ink-3)' }}>
            ← back home
          </Link>
        </div>
      </section>
    </main>
  );
}
