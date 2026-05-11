import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Example App — Relay integration demo',
  description: 'A minimal Next.js app that accepts agent-driven signups via Relay.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: 720,
          margin: '64px auto',
          padding: '0 24px',
          color: '#111',
        }}
      >
        {children}
      </body>
    </html>
  );
}
