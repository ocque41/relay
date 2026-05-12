interface StatProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}

export function Stat({ label, value, sub }: StatProps) {
  return (
    <div className="stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export function Stats({ children }: { children: React.ReactNode }) {
  return (
    <section className="stats" aria-label="Snapshot">
      {children}
    </section>
  );
}
