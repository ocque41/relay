import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';

export const metadata = {
  title: 'Welcome — Founding Partner Sprint',
  description: 'Your founding partner sprint is reserved.',
};

const wrap = {
  maxWidth: 720,
  margin: '0 auto',
  padding: '120px 24px 80px',
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

type Props = {
  searchParams: Promise<{ session_id?: string }>;
};

export default async function Welcome({ searchParams }: Props) {
  const params = await searchParams;
  return (
    <main style={wrap}>
      <Kicker>Founding Partner Sprint · Reserved</Kicker>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          fontSize: 'clamp(36px, 4.5vw, 48px)',
          lineHeight: 1.05,
          letterSpacing: '-0.015em',
          margin: '20px 0 16px',
        }}
      >
        Got it. Sprint starts within 24 hours.
      </h1>
      <p style={body}>
        I&rsquo;ll email you within a business day with a short intake form
        (your signup webhook, your direct-signup baseline export instructions,
        and a slot for a 20-minute kickoff call). The 30-day sprint clock
        starts the day we deploy the integration to your staging environment.
      </p>
      <p style={{ ...body, marginTop: 16 }}>
        If you don&rsquo;t hear back within 24 hours, ping{' '}
        <a href="mailto:hi@cumulush.com" style={{ color: 'var(--color-ink)' }}>
          hi@cumulush.com
        </a>
        .
      </p>
      {params.session_id ? (
        <p style={{ ...small, marginTop: 32 }}>
          Stripe session: <code>{params.session_id}</code>
        </p>
      ) : null}
      <p style={{ ...small, marginTop: 32 }}>
        <Link href="/" style={{ color: 'var(--color-ink-3)' }}>
          ← back home
        </Link>
      </p>
    </main>
  );
}
