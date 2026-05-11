import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';

export const metadata = {
  title: 'Security — Relay',
  description:
    'Encryption at rest, HMAC webhook signing, agent-token hashing, audit log, rate limits, and our SOC 2 roadmap.',
};

export default function SecurityPage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '96px 24px',
        fontFamily: 'var(--font-display)',
      }}
    >
      <Kicker>Trust · security</Kicker>
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
        Security.
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
        Relay sits between AI agents and third-party APIs and stores
        credentials on your behalf. Every design decision here optimizes for
        keeping those credentials out of attacker hands without making the
        product unusable for agents.
      </p>

      <Section title="Encryption at rest">
        Every credential column (third-party API keys, tenant webhook signing
        secrets, pending-account credentials) is encrypted at the application
        layer with <b>AES-256-GCM</b>. Each ciphertext carries a 12-byte
        random nonce and a 16-byte authentication tag. The master key is a
        32-byte secret stored in Vercel environment variables and never logged
        or committed. A {`key_version`} column on every encrypted table makes
        rotation to a v2 master key possible without a migration window.
      </Section>

      <Section title="Encryption in transit">
        TLS 1.2+ on every public endpoint. HTTP-to-HTTPS redirects handled by
        Vercel&apos;s edge. HSTS with a year-long max-age and preload.
      </Section>

      <Section title="Authentication">
        <List>
          <li>
            <b>Human sign-in</b> — passwordless email OTP + WebAuthn passkeys.
            No password storage; no password reset email path.
          </li>
          <li>
            <b>Agent tokens</b> — stored as SHA-256 digests. The plaintext is
            shown exactly once at mint and never again. Revocation is a
            server-side flag that invalidates the row immediately.
          </li>
          <li>
            <b>Integrator webhooks</b> — outbound calls carry an{' '}
            {`X-Relay-Signature: sha256=…`} header HMAC-ed with the tenant&apos;s
            per-product secret. Integrators MUST verify this before acting.
          </li>
          <li>
            <b>Inbound email</b> — SendGrid Inbound Parse posts to{' '}
            {`/v1/webhooks/email?secret=…`}. Any value mismatch returns 401 and
            drops the payload.
          </li>
        </List>
      </Section>

      <Section title="Audit log">
        Every mutation by an authenticated caller writes an {`audit_log`} row
        with actor, action, target, timestamp, and contextual metadata.
        Supported events include {`signup_create`}, {`key_create`},{' '}
        {`key_reveal`}, {`key_deliver`}, {`account_delete`}, {`tenant_create`},{' '}
        {`admin.raise_signup_limit`}, and all billing state changes. Rows are
        append-only; deletes are prohibited at the application layer.
      </Section>

      <Section title="Rate limits">
        <List>
          <li>
            <b>Per-token API limits</b> — 60 writes/min and 300 reads/min
            (best-effort, per-instance on Vercel Fluid Compute). Designed to
            catch runaway agents rather than act as a hard quota.
          </li>
          <li>
            <b>Per-user monthly signup cap</b> — default 50/month. Breaches
            are logged and, in enforce mode, return HTTP 429. Ops can raise
            the ceiling per user via the admin API.
          </li>
          <li>
            <b>Integrator action quota</b> — enforced atomically on dispatch
            for every billable action (signup / reveal / rotate / delete);
            overage queues per-action invoice items for monthly flush.
          </li>
        </List>
      </Section>

      <Section title="Observability">
        Sentry captures unhandled errors and rate-limit breaches; a pino
        structured logger writes JSON to Vercel logs. Sensitive headers
        ({`authorization`}, {`cookie`}) and token fields are redacted before
        leaving the process.
      </Section>

      <Section title="Multi-tenant isolation">
        Every resource row carries {`tenant_id`} and/or {`user_id`}; every
        authenticated route validates both before reading or writing. Cross-
        tenant reads are an automatic test target; we are planning Postgres
        row-level security as a belt-and-suspenders layer post-launch.
      </Section>

      <Section title="Vulnerability reporting">
        Report security issues to {`security@cumulush.com`} (PGP key on
        request). We acknowledge within 48 hours and patch critical issues
        within 7 days. See the full policy in <code>SECURITY.md</code> on
        the repo.
      </Section>

      <Section title="Compliance roadmap">
        We are targeting <b>SOC 2 Type I</b> in Q4 2026 with a Type II report
        to follow the subsequent audit period. GDPR and CCPA data-subject
        rights are honored today; contact {`privacy@cumulush.com`}. A Data
        Processing Agreement (DPA) is available to any paying integrator on
        request.
      </Section>

      <Section title="Source-availability">
        Relay&apos;s service code is open source under AGPL-3.0. The Cumulus
        creator package and generated app templates are MIT-licensed so
        integrators can audit, fork, or pin the code that handles webhooks,
        signs requests, and brokers the Relay handshake on their side. Teams
        can use hosted Relay or run their own Relay deployment.
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
        <Link href="/trust">Trust</Link>
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

function List({ children }: { children: React.ReactNode }) {
  return <ul style={{ paddingLeft: 20, margin: '8px 0' }}>{children}</ul>;
}
