'use client';

import { useToast } from './Toast';

interface MonoValProps {
  value: string;
  copyable?: boolean;
  children?: React.ReactNode;
}

export function MonoVal({ value, copyable = true, children }: MonoValProps) {
  const toast = useToast();
  return (
    <>
      <span className="addr">{children ?? value}</span>
      {copyable && (
        <button
          type="button"
          className="copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast.show('Copied');
            } catch {
              toast.show('Copy failed');
            }
          }}
        >
          Copy
        </button>
      )}
    </>
  );
}
