'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NavItem } from '../router';
import { navNumber } from '../router';

export interface PaletteAction {
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  nav: NavItem[];
  actions?: PaletteAction[];
  footerRight?: string;
}

type Entry =
  | { kind: 'nav'; n: string; label: string; hint: string; href: string }
  | { kind: 'act'; n: '—'; label: string; hint: string; run: () => void | Promise<void> };

export function CommandPalette({ open, onClose, nav, actions = [], footerRight }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The element that had focus before the palette opened. We restore focus
  // here when the palette closes so keyboard users land back where they
  // came from instead of at the document root.
  const openerRef = useRef<HTMLElement | null>(null);

  const allEntries: Entry[] = useMemo(() => {
    const n: Entry[] = nav.map((item, i) => ({
      kind: 'nav',
      n: navNumber(i),
      label: item.label,
      hint: item.href,
      href: item.href,
    }));
    const a: Entry[] = actions.map((act) => ({
      kind: 'act',
      n: '—',
      label: act.label,
      hint: act.hint ?? '',
      run: act.run,
    }));
    return [...n, ...a];
  }, [nav, actions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allEntries;
    return allEntries.filter((e) => e.label.toLowerCase().includes(q));
  }, [allEntries, query]);

  useEffect(() => {
    if (open) {
      // Capture the previously-focused element so we can restore focus on close.
      openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
      setQuery('');
      setHighlight(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    // Closed: restore focus to whoever opened us, if they're still in the DOM.
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) {
      opener.focus();
    }
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // Focus trap: while the palette is open, Tab and Shift+Tab cycle within
  // the palette's focusable elements instead of escaping into the page
  // behind us. Standard modal-dialog a11y pattern; pairs with the
  // role="dialog" + aria-modal="true" attributes on the container.
  useEffect(() => {
    if (!open) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const c = containerRef.current;
      if (!c) return;
      const focusable = Array.from(
        c.querySelectorAll<HTMLElement>(
          'input, button, [href], select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !c.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onTab);
    return () => window.removeEventListener('keydown', onTab);
  }, [open]);

  const choose = async (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.kind === 'nav') {
      router.push(entry.href);
    } else {
      await entry.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!filtered.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[highlight]);
    }
  };

  if (!open) return null;

  let idx = -1;
  const navItems = filtered.filter((e) => e.kind === 'nav');
  const actItems = filtered.filter((e) => e.kind === 'act');

  return (
    <div
      ref={containerRef}
      className="palette on"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="palette-box">
        <div className="palette-input">
          <span className="palette-lead">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a destination, account, key…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div ref={listRef} className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-item empty">
              <span className="n">—</span>No results
              <span className="d">try another term</span>
            </div>
          ) : (
            <>
              {navItems.length > 0 && <div className="palette-section">Navigate</div>}
              {navItems.map((e) => {
                idx += 1;
                const hi = idx === highlight;
                const myIdx = idx;
                return (
                  <button
                    key={`nav-${e.label}`}
                    type="button"
                    className={`palette-item ${hi ? 'hi' : ''}`}
                    onMouseEnter={() => setHighlight(myIdx)}
                    onClick={() => choose(e)}
                  >
                    <span className="n">{e.n}</span>
                    {e.label}
                    <span className="d">{e.hint}</span>
                  </button>
                );
              })}
              {actItems.length > 0 && <div className="palette-section">Actions</div>}
              {actItems.map((e) => {
                idx += 1;
                const hi = idx === highlight;
                const myIdx = idx;
                return (
                  <button
                    key={`act-${e.label}`}
                    type="button"
                    className={`palette-item ${hi ? 'hi' : ''}`}
                    onMouseEnter={() => setHighlight(myIdx)}
                    onClick={() => choose(e)}
                  >
                    <span className="n">{e.n}</span>
                    {e.label}
                    <span className="d">{e.hint}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ move · ↩ open · esc close</span>
          {footerRight && <span>{footerRight}</span>}
        </div>
      </div>
    </div>
  );
}
