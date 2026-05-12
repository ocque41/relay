/**
 * Minimal shell for /share/[token]. Zero nav, zero auth dependencies — the
 * token is the only thing that grants access.
 */
export default function ShareLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-paper)',
        color: 'var(--color-ink)',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          margin: '0 auto',
          padding: '96px 24px 64px',
        }}
      >
        {children}
      </div>
    </div>
  );
}
