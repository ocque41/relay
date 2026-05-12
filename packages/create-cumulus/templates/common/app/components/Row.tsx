interface RowProps {
  label: React.ReactNode;
  children: React.ReactNode;
}

export function Row({ label, children }: RowProps) {
  return (
    <section className="row">
      <div className="lbl">{label}</div>
      <div className="val-prose">{children}</div>
    </section>
  );
}

export function RowMono({ label, children }: RowProps) {
  return (
    <section className="row">
      <div className="lbl">{label}</div>
      <div className="val-mono">{children}</div>
    </section>
  );
}
