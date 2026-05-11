'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface ToastCtx {
  show: (msg: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // No provider yet → noop. Safer than throwing in an SSR edge.
    return { show: () => {} };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((m: string) => {
    if (timeout.current) clearTimeout(timeout.current);
    setMsg(m);
    setOn(true);
    timeout.current = setTimeout(() => setOn(false), 1400);
  }, []);

  useEffect(() => () => {
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className={`toast ${on ? 'on' : ''}`} role="status" aria-live="polite">
        {msg}
      </div>
    </Ctx.Provider>
  );
}
