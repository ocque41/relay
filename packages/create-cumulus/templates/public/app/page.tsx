import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';
import { ReserveSprintButton } from '@/app/components/ReserveSprintButton';

const navWrap = {
  maxWidth: 1200,
  margin: '0 auto',
  padding: '28px 24px 0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 20,
  flexWrap: 'wrap' as const,
} as const;

const navBrand = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.22em',
  textTransform: 'uppercase' as const,
  fontWeight: 600,
  color: 'var(--color-ink)',
} as const;

const navBrandSmall = {
  marginLeft: 10,
  fontSize: 9,
  letterSpacing: '0.16em',
  color: 'var(--color-ink-3)',
  fontWeight: 400,
} as const;

const navLinks = {
  display: 'flex',
  gap: 28,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  color: 'var(--color-ink-2)',
  textTransform: 'uppercase' as const,
} as const;

const navCta = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase' as const,
  padding: '9px 14px',
  border: '1px solid var(--color-ink)',
  color: 'var(--color-ink)',
} as const;

export const metadata = {
  title: 'Relay — Agent-driven activated users for AI-infra APIs',
  description:
    'AI agents like Cursor, Claude Code, and Codex try to set up your API for their users — and stall at the signup wall. Relay finishes that loop so you collect activated users, not abandoned signups.',
};

const sectionWrap = {
  maxWidth: 880,
  margin: '0 auto',
  padding: '0 24px',
} as const;

const heroH1 = {
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  letterSpacing: '-0.015em',
  fontSize: 'clamp(40px, 6vw, 64px)',
  lineHeight: 1.05,
  color: 'var(--color-ink)',
  margin: '24px 0 24px',
} as const;

const lead = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  lineHeight: 1.45,
  color: 'var(--color-ink-2)',
  margin: '0 0 32px',
  maxWidth: 720,
} as const;

const sectionH = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--color-ink-3)',
  margin: '64px 0 16px',
} as const;

const body = {
  fontFamily: 'var(--font-body)',
  fontSize: 17,
  lineHeight: 1.65,
  color: 'var(--color-ink-2)',
} as const;

const small = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  color: 'var(--color-ink-3)',
} as const;

const card = {
  border: '1px solid var(--color-rule)',
  borderRadius: 8,
  padding: '24px 26px',
  margin: '12px 0',
  background: 'var(--color-paper)',
} as const;

export default function Home() {
  return (
    <>
      <nav aria-label="Primary" style={navWrap}>
        <Link href="/" style={navBrand}>
          <span className="brand-dot" aria-hidden="true" />
          Relay
          <small style={navBrandSmall}>by Cumulus</small>
        </Link>
        <div style={navLinks}>
          <Link href="/pricing">Offer</Link>
          <Link href="/docs/developer">Docs</Link>
          <Link href="/trust">Trust</Link>
        </div>
        <Link href="/login" style={navCta}>
          Sign in →
        </Link>
      </nav>

      <header style={{ ...sectionWrap, padding: '88px 24px 0' }}>
        <Kicker>Founding Partner Program · For AI-native API companies</Kicker>
        <h1 style={heroH1}>
          Your users keep asking AI agents to set up your API. The agents keep getting stuck.
        </h1>
        <p style={lead}>
          When a developer asks Cursor, Claude Code, or Codex to wire up your API, the agent is
          fluent up until your signup wall — then it tells the user to open a browser and paste
          a key. Most don&rsquo;t come back. Relay closes that loop, then sends you a monthly
          cohort report so you can see what the agent-onboarded segment of your users looks like.
        </p>

        <ReserveSprintButton />
        <div style={{ ...small, marginTop: 14 }}>
          $2,500 prepaid · 30-day sprint · day-30 cohort report · renewal at $2,500/mo, decided
          after the report.
        </div>
      </header>

      <section style={sectionWrap}>
        <h2 style={sectionH}>What you get in 30 days</h2>
        <div style={card}>
          <div style={{ ...small, marginBottom: 6 }}>01 · Integration</div>
          <div style={body}>
            We add a webhook into your signup flow plus a one-line SDK call inside your
            key-validation middleware. Your existing auth doesn&rsquo;t change. Cursor, Claude Code,
            and Codex agents using the Relay loop can complete signup, verify email, receive a
            real key, and make an authenticated call without ever bouncing your user to a browser.
          </div>
        </div>
        <div style={card}>
          <div style={{ ...small, marginBottom: 6 }}>02 · Instrumentation</div>
          <div style={body}>
            Each Relay-issued key emits a single event the first time it&rsquo;s used for an
            authenticated, non-test, non-healthcheck request. We join that event back to the
            signup it came from and stamp activation timing precisely.
          </div>
        </div>
        <div style={card}>
          <div style={{ ...small, marginBottom: 6 }}>03 · Day-30 cohort report</div>
          <div style={body}>
            On day 30 you receive a Markdown report covering agent-attributed signups, completed
            signups, key handoffs, first authenticated calls, 24-hour and 7-day activation rates,
            time-to-first-call distribution, and — if you supply a direct-signup baseline cohort —
            an apples-to-apples comparison against your normal funnel. Without that baseline the
            numbers exist in a vacuum, so we ask for it as part of the SOW.
          </div>
        </div>
      </section>

      <section style={sectionWrap}>
        <h2 style={sectionH}>Who this is for</h2>
        <div style={body}>
          Founder/CEOs at AI-native API startups roughly $1M–$5M ARR. Model routers,
          eval/observability, browser/search/data APIs, sandbox and devtool APIs, rerank and
          embedding services. If you sell API access to developers and your users are starting
          inside a coding agent, agents are already attempting to onboard for them — and stalling.
        </div>
        <div style={{ ...body, marginTop: 16 }}>
          We are intentionally <em>not</em> the right fit for: enterprise-only sales, teams without
          public API docs, products without a developer pricing tier, or anything heavy on
          regulatory friction.
        </div>
      </section>

      <section style={sectionWrap}>
        <h2 style={sectionH}>Honest scope</h2>
        <ul style={{ ...body, paddingLeft: 22 }}>
          <li>
            We don&rsquo;t replace your auth. Clerk, Auth0, Supabase, your own — they all keep
            issuing the session. Relay only handles the agent-driven onboarding side door.
          </li>
          <li>
            We don&rsquo;t guarantee traffic. We close the loop; demand still has to come from
            your users asking their agents to use your API.
          </li>
          <li>
            Cursor, Claude Code, and Codex are mentioned as examples of where agents originate.
            They are not partners and we don&rsquo;t imply endorsement.
          </li>
          <li>
            Activation = first successful authenticated API call from a Relay-issued key, within
            24 hours of the genuine handoff. Test traffic, healthchecks, and docs/playground
            pings are excluded if your middleware filters them out before reporting.
          </li>
        </ul>
      </section>

      <section style={sectionWrap}>
        <h2 style={sectionH}>Reserve a sprint</h2>
        <div style={body}>
          $2,500 prepaid covers integration + 30 days of operation + the day-30 cohort report.
          If the report shows a channel worth keeping, you renew at $2,500/month, month-to-month.
          If it doesn&rsquo;t, don&rsquo;t. We&rsquo;re still figuring out who this works for, so
          we&rsquo;d rather hear &ldquo;not a fit&rdquo; than carry a customer who isn&rsquo;t
          getting value.
        </div>
        <div style={{ marginTop: 24 }}>
          <ReserveSprintButton />
        </div>
        <div style={{ ...small, marginTop: 24 }}>
          Prefer a conversation first? Email{' '}
          <a href="mailto:hi@cumulush.com" style={{ color: 'var(--color-ink)' }}>
            hi@cumulush.com
          </a>
          .
        </div>
      </section>

      <footer style={{ ...sectionWrap, padding: '120px 24px 64px' }}>
        <div style={{ ...small, color: 'var(--color-ink-3)' }}>
          Relay by Cumulus · concierge phase · February 2026
        </div>
      </footer>
    </>
  );
}
