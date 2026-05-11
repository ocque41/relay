import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';

export const metadata = {
  title: 'Privacy policy — Relay',
  description:
    "What personal data Relay collects, why, how long it's kept, and the subprocessors that touch it.",
};

const effective = '2026-04-19';

export default function PrivacyPage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '96px 24px',
        fontFamily: 'var(--font-display)',
      }}
    >
      <Kicker>Legal · privacy</Kicker>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 300,
          fontSize: 48,
          lineHeight: 1,
          letterSpacing: '-0.025em',
          margin: '0 0 24px',
        }}
      >
        Privacy policy.
      </h1>
      <p
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: 'var(--color-ink-3)',
          marginBottom: 48,
        }}
      >
        Effective {effective}. Operator: Cumulus ({`hi@cumulush.com`}).
      </p>

      <Section title="Who we are">
        Relay is operated by Cumulus ({`hi@cumulush.com`}, 5757 Woodway Drive,
        Houston TX 77057, US). Relay provides an HTTP API and MCP server that
        AI agents use to sign their users up to third-party products on behalf
        of their end-users. We are a data processor for integrator tenants and
        a data controller for our own account records.
      </Section>

      <Section title="What we collect">
        <List>
          <li>
            <b>Account data.</b> Email address, optional name, WebAuthn public
            credentials, IP address + user agent for active sessions, agent
            token hashes (SHA-256; we never store plaintext).
          </li>
          <li>
            <b>Integration metadata.</b> Tenant slug, domain, webhook URL,
            HMAC signing secret (stored encrypted at rest via AES-256-GCM),
            product catalog entries, billing subscription state.
          </li>
          <li>
            <b>Signup ledger.</b> For each signup an agent dispatches:
            provider slug, input fields, resulting account id + API key
            (encrypted), and the audit event. Third-party API keys pass through
            Relay exactly once and are not persisted.
          </li>
          <li>
            <b>Agent inbox.</b> Inbound emails addressed to a user&apos;s
            Relay alias are stored in full (headers + plain-text body) so the
            agent can read and extract verification codes. Retained 90 days.
          </li>
          <li>
            <b>Billing data.</b> Stripe customer id, subscription state,
            per-action quota counters, per-action overage invoice items. We
            do NOT store card numbers — Stripe holds those directly.
          </li>
        </List>
      </Section>

      <Section title="How we use it">
        <List>
          <li>Deliver the service: authenticate requests, dispatch signups, route inbound email.</li>
          <li>Bill integrators for billable actions and per-action overage.</li>
          <li>Detect abuse: per-user monthly action counter, audit log.</li>
          <li>Contact account owners for operational and billing notices.</li>
          <li>Investigate security incidents.</li>
        </List>
        <p>
          We do not sell personal data. We do not use it to train AI models.
        </p>
      </Section>

      <Section title="Subprocessors">
        Data may be processed by the following subprocessors, each under a
        data processing agreement:
        <List>
          <li><b>Neon</b> — managed Postgres hosting (data at rest).</li>
          <li><b>Vercel</b> — application hosting + edge network (compute, logs).</li>
          <li><b>Resend</b> — outbound transactional email (verification codes, receipts).</li>
          <li><b>SendGrid</b> — inbound email parsing (the agent inbox).</li>
          <li><b>Stripe</b> — subscription and overage billing; stores card numbers.</li>
          <li><b>Sentry</b> — error and performance monitoring.</li>
        </List>
        A full current list lives at <Link href="/trust">/trust</Link>.
      </Section>

      <Section title="Retention">
        <List>
          <li><b>Account records</b> — while the account is open. Deleted within 30 days of closure.</li>
          <li><b>Audit log</b> — 12 months from event timestamp.</li>
          <li><b>Inbound emails</b> — 90 days.</li>
          <li><b>Session records</b> — until expiration or revocation.</li>
          <li><b>Billing records</b> — 7 years for tax and accounting compliance.</li>
        </List>
      </Section>

      <Section title="Your rights">
        Subject to applicable law (GDPR, CCPA, and similar), you can request
        access, correction, deletion, export, or restriction of processing of
        your personal data. Email {`privacy@cumulush.com`} from the address
        associated with your account. We aim to respond within 30 days.
      </Section>

      <Section title="International transfers">
        Data is stored in the United States. For EU/UK transfers we rely on
        Standard Contractual Clauses with each subprocessor.
      </Section>

      <Section title="Changes">
        Material changes to this policy will be announced via email to account
        owners at least 14 days before they take effect. Non-material changes
        (clarifications, subprocessor additions under similar protections)
        take effect on publication.
      </Section>

      <Section title="Contact">
        {`privacy@cumulush.com`} for privacy requests · {`security@cumulush.com`} for security issues · {`hi@cumulush.com`} for general inquiries.
      </Section>

      <footer
        style={{
          marginTop: 72,
          paddingTop: 24,
          borderTop: '1px solid var(--color-hair)',
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: 'var(--color-ink-3)',
        }}
      >
        <Link href="/">Home</Link>
        <Link href="/legal/terms">Terms</Link>
        <Link href="/security">Security</Link>
        <Link href="/trust">Trust</Link>
      </footer>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 48 }}>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          fontSize: 22,
          margin: '0 0 12px',
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontSize: 15,
          color: 'var(--color-ink-2)',
          lineHeight: 1.6,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return (
    <ul style={{ paddingLeft: 20, margin: '0 0 12px' }}>
      {children}
    </ul>
  );
}
