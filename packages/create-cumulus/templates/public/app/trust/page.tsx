import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';

export const metadata = {
  title: 'Trust center — Relay',
  description: 'Subprocessor list, reliability targets, incident communication, and security contacts.',
};

interface Subprocessor {
  name: string;
  role: string;
  dataCategories: string;
  region: string;
}

const subprocessors: Subprocessor[] = [
  {
    name: 'Neon',
    role: 'Managed Postgres',
    dataCategories: 'All persistent application data at rest',
    region: 'US',
  },
  {
    name: 'Vercel',
    role: 'Application hosting + edge network',
    dataCategories: 'Compute, request logs, built artifacts, env vars',
    region: 'US',
  },
  {
    name: 'Resend',
    role: 'Outbound transactional email',
    dataCategories: 'Email addresses, OTP codes, confirmation links',
    region: 'US',
  },
  {
    name: 'SendGrid',
    role: 'Inbound email parsing',
    dataCategories: 'Raw inbound email headers + body',
    region: 'US',
  },
  {
    name: 'Stripe',
    role: 'Billing (integrator subscriptions + overage)',
    dataCategories: 'Customer records, card numbers, invoices',
    region: 'US',
  },
  {
    name: 'Sentry',
    role: 'Error and performance monitoring',
    dataCategories: 'Stack traces, request metadata (PII-redacted)',
    region: 'US',
  },
];

export default function TrustPage() {
  return (
    <main
      style={{
        maxWidth: 840,
        margin: '0 auto',
        padding: '96px 24px',
        fontFamily: 'var(--font-display)',
      }}
    >
      <Kicker>Trust center</Kicker>
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
        Trust.
      </h1>
      <p
        style={{
          fontSize: 17,
          color: 'var(--color-ink-2)',
          lineHeight: 1.5,
          maxWidth: 560,
          marginBottom: 48,
        }}
      >
        The operational face of Relay: who touches your data, what we commit
        to on uptime, how incidents are communicated, and where to report a
        security issue.
      </p>

      <Section title="Subprocessors">
        Relay shares data with the subprocessors below strictly to deliver the
        Service. Each operates under a data processing agreement. We will
        notify account owners at least 30 days before adding a new
        subprocessor with materially different access.
        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-hair)' }}>
                <th style={{ padding: '8px 12px' }}>Vendor</th>
                <th style={{ padding: '8px 12px' }}>Role</th>
                <th style={{ padding: '8px 12px' }}>Data</th>
                <th style={{ padding: '8px 12px' }}>Region</th>
              </tr>
            </thead>
            <tbody>
              {subprocessors.map((s) => (
                <tr key={s.name} style={{ borderBottom: '1px solid var(--color-hair)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{s.name}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-ink-2)' }}>{s.role}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-ink-2)' }}>{s.dataCategories}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-ink-2)' }}>{s.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Reliability">
        We target <b>99.5% monthly availability</b> on the Builder, Starter, and
        Growth tiers and <b>99.9%</b> on the Scale tier. Enterprise customers
        can contract to <b>99.95%</b>. Availability excludes scheduled
        maintenance windows announced in advance via email. Scale tenants
        also get the internal-latency benchmark probe run against their
        deployment every 5 minutes.
      </Section>

      <Section title="Incident response">
        For severity-1 incidents (data exposure, broad authentication bypass,
        total service outage) we aim for an initial customer-facing
        acknowledgment within 1 hour and a written post-incident report
        within 7 days. Public status for major incidents is emailed to
        account owners and posted on /trust.
      </Section>

      <Section title="Security contact">
        Report vulnerabilities to {`security@cumulush.com`}. Please do not
        include exploit details in the subject line. PGP key available on
        request; see the repo&apos;s{' '}
        <Link href="https://github.com/Cumulus-s/relay/blob/main/SECURITY.md">
          SECURITY.md
        </Link>{' '}
        for the full disclosure policy.
      </Section>

      <Section title="Changelog">
        We publish a user-visible changelog in the repo&apos;s{' '}
        <Link href="https://github.com/Cumulus-s/relay/blob/main/CHANGELOG.md">
          CHANGELOG.md
        </Link>
        .
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
        <Link href="/security">Security</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
      </footer>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          fontSize: 20,
          margin: '0 0 10px',
        }}
      >
        {title}
      </h2>
      <div style={{ fontSize: 15, color: 'var(--color-ink-2)', lineHeight: 1.6 }}>
        {children}
      </div>
    </section>
  );
}
