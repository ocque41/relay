import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';

export const metadata = {
  title: 'Terms of service — Relay',
  description: 'Terms governing your use of the Relay API, dashboard, SDK, and CLI.',
};

const effective = '2026-04-19';

export default function TermsPage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '96px 24px',
        fontFamily: 'var(--font-display)',
      }}
    >
      <Kicker>Legal · terms</Kicker>
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
        Terms of service.
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
        Effective {effective}.
      </p>

      <Section title="1. Agreement">
        These Terms of Service (the &ldquo;Terms&rdquo;) govern your use of the
        Relay API, dashboard, MCP server, SDK, and CLI (the &ldquo;Service&rdquo;),
        operated by Cumulus (&ldquo;we,&rdquo; &ldquo;us&rdquo;). By creating an
        account or signing a subscription you agree to these Terms.
      </Section>

      <Section title="2. Accounts">
        You must be at least 18 years old and provide accurate account
        information. You are responsible for safeguarding your credentials,
        including agent tokens and API keys. You are liable for actions taken
        under your account.
      </Section>

      <Section title="3. Fees and billing">
        Integrator subscriptions are billed monthly via Stripe at the plan
        rate plus per-signup overage beyond the included quota. All fees are
        in US Dollars and exclusive of taxes. Subscriptions renew
        automatically until canceled; downgrades take effect at the end of
        the current billing period. Failed signups refund the corresponding
        quota slot automatically; charges that have already been invoiced are
        non-refundable except where required by law.
      </Section>

      <Section title="4. Acceptable use">
        You will not:
        <List>
          <li>Use the Service for unlawful activity or to harass, threaten, or defraud.</li>
          <li>Circumvent rate limits, quotas, or authentication controls.</li>
          <li>Reverse-engineer, decompile, or attempt to derive source code (except where permitted by law).</li>
          <li>Use the Service to build a competing product that resells Relay functionality.</li>
          <li>
            Submit content that infringes a third party&apos;s intellectual
            property, privacy, or publicity rights.
          </li>
        </List>
      </Section>

      <Section title="5. Your content">
        You retain all rights to the data, content, and configuration you
        submit to the Service. You grant us a worldwide, non-exclusive,
        royalty-free license to process it solely to deliver the Service.
      </Section>

      <Section title="6. Confidentiality">
        Both parties will protect the other&apos;s non-public information with
        at least the same care used to protect their own, and will use it only
        to perform under these Terms.
      </Section>

      <Section title="7. Service availability">
        We aim for high availability but do not guarantee uninterrupted
        service except where a signed contract specifies an SLA. Scheduled
        maintenance windows and best-effort incident communication live at
        <Link href="/trust"> /trust</Link>.
      </Section>

      <Section title="8. Warranty disclaimer">
        The Service is provided &ldquo;AS IS&rdquo; without warranty of any
        kind. To the maximum extent permitted by law, we disclaim all
        warranties, express or implied, including merchantability, fitness for
        a particular purpose, and non-infringement.
      </Section>

      <Section title="9. Limitation of liability">
        To the maximum extent permitted by law, our aggregate liability
        arising out of or relating to these Terms will not exceed the greater
        of (a) the fees you paid to us in the twelve months preceding the
        event giving rise to the claim, or (b) one hundred US Dollars ($100).
        We will not be liable for lost profits, lost revenue, or consequential
        damages, even if advised of their possibility.
      </Section>

      <Section title="10. Indemnification">
        You will defend, indemnify, and hold us harmless from third-party
        claims arising out of your content, your breach of these Terms, or
        your violation of applicable law.
      </Section>

      <Section title="11. Termination">
        Either party may terminate for material breach not cured within 30
        days of notice. We may suspend the Service immediately for non-payment,
        violation of the acceptable-use policy, or activity that threatens
        the security or integrity of the platform.
      </Section>

      <Section title="12. Governing law">
        These Terms are governed by the laws of the State of Texas, United
        States, without regard to conflict-of-laws principles. Venue for any
        dispute lies in the state or federal courts located in Harris County,
        Texas.
      </Section>

      <Section title="13. Changes">
        We may update these Terms from time to time. Material changes take
        effect 30 days after we notify account owners by email. Continued use
        after the effective date constitutes acceptance.
      </Section>

      <Section title="14. Contact">
        {`hi@cumulush.com`} · 5757 Woodway Drive, Houston TX 77057, US.
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
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/security">Security</Link>
        <Link href="/trust">Trust</Link>
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
