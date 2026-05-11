'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '../router';
import { activeNavHref, navNumber } from '../router';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { ThemeToggle } from './ThemeToggle';
import { ToastProvider, useToast } from './Toast';

export interface ShellFooter {
  primary: string;
  secondary?: string;
  signOutAction: string;
}

interface Props {
  nav: NavItem[];
  brand: { line1: string; line2?: string };
  workspaceLabel: string;
  footer: ShellFooter;
  workspaceSwitcher: React.ReactNode;
  paletteActions?: PaletteAction[];
  paletteFooterRight?: string;
  drawerLabel?: string;
  children: React.ReactNode;
}

export function DashboardShell(props: Props) {
  return (
    <ToastProvider>
      <ShellInner {...props} />
    </ToastProvider>
  );
}

function ShellInner({
  nav,
  brand,
  workspaceLabel,
  footer,
  workspaceSwitcher,
  paletteActions,
  paletteFooterRight,
  drawerLabel,
  children,
}: Props) {
  const pathname = usePathname();
  const current = activeNavHref(nav, pathname ?? '');
  const currentItem = nav.find((item) => item.href === current);
  const sectionLabel = (currentItem?.label ?? 'Section').toLowerCase();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toast = useToast();
  // Refs for focus management on the mobile menu button + drawer close.
  // When the drawer opens we move focus into it; on close we restore focus
  // to the hamburger so keyboard users land back where they came from.
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const openPalette = useCallback(() => {
    setDrawerOpen(false);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // ⌘K / Ctrl+K toggle, Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'k') {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        setDrawerOpen(false);
        return;
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Scroll-lock body while drawer or palette is open. Two distinct body
  // classes — both map to the same `overflow:hidden; touch-action:none`
  // rule today but stay separate so a future stylesheet can give them
  // different visual treatment without touching this hook.
  useEffect(() => {
    document.body.classList.toggle('drawer-open', drawerOpen);
    document.body.classList.toggle('palette-open', paletteOpen);
    return () => {
      document.body.classList.remove('drawer-open');
      document.body.classList.remove('palette-open');
    };
  }, [drawerOpen, paletteOpen]);

  // Drawer focus management: move focus into the drawer (close button) on
  // open so keyboard users get a sensible Tab landing point. Restore to
  // the hamburger on close. The drawer also carries `inert={!drawerOpen}`
  // which removes its descendants from the focus order entirely while
  // closed, so this hook is purely about the open transition.
  useEffect(() => {
    if (drawerOpen) {
      // Small delay lets the slide-in transition start before focus jumps.
      const t = setTimeout(() => drawerCloseRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    if (menuButtonRef.current && document.contains(menuButtonRef.current)) {
      menuButtonRef.current.focus();
    }
  }, [drawerOpen]);

  const actions: PaletteAction[] = [
    ...(paletteActions ?? []),
  ];

  // Action wrapper that also fires a toast for copy ops.
  const enhancedActions: PaletteAction[] = actions.map((a) => ({
    ...a,
    run: async () => {
      try {
        await a.run();
      } catch {
        toast.show('Action failed');
      }
    },
  }));

  return (
    <>
      <div className="relay-app">
        {/* Desktop sidebar */}
        <aside className="rail" aria-label="Primary">
          <div className="brand">
            <span className="brand-dot" aria-hidden="true" />
            {brand.line1}
            {brand.line2 && <small>{brand.line2}</small>}
          </div>

          <button
            type="button"
            className="cmdk"
            onClick={openPalette}
            aria-label="Open command palette"
          >
            <span className="ph">Go to…</span>
            <span className="kbd">⌘ K</span>
          </button>

          <nav className="nav" aria-label="Sections">
            {nav.map((item, i) => {
              const isActive = item.href === current;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span>{item.label}</span>
                  <span className="n">{navNumber(i)}</span>
                </Link>
              );
            })}
          </nav>

          <div className="rail-foot">
            <ThemeToggle surface="rail" />
            <div className="ws-slot">{workspaceSwitcher}</div>
            <b>{footer.primary}</b>
            {footer.secondary && (
              <>
                <br />
                <span>{footer.secondary}</span>
              </>
            )}
            <br />
            <form action={footer.signOutAction} method="post">
              <button type="submit">Sign out</button>
            </form>
          </div>
        </aside>

        {/* Mobile topbar */}
        <header className="topbar">
          <div className="brand">
            <span className="brand-dot" aria-hidden="true" />
            {brand.line1}
          </div>
          <div className="where">
            <span>{workspaceLabel}</span>
            <span className="slash">/</span>
            <b>{sectionLabel}</b>
          </div>
          <div className="acts">
            <button
              type="button"
              className="k"
              onClick={openPalette}
              aria-label="Open command palette"
            >
              ⌘ K
            </button>
            <button
              ref={menuButtonRef}
              type="button"
              className="menu"
              onClick={openDrawer}
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls="relay-drawer"
            >
              <span className="bar" />
              <span className="bar" />
              <span className="bar" />
            </button>
          </div>
        </header>

        <main className="main">{children}</main>
      </div>

      {/* Drawer scrim + drawer */}
      <div
        className={`drawer-scrim ${drawerOpen ? 'on' : ''}`}
        onClick={closeDrawer}
        aria-hidden="true"
      />
      <aside
        className={`drawer ${drawerOpen ? 'on' : ''}`}
        aria-label={drawerLabel ?? 'All sections'}
        aria-hidden={!drawerOpen}
        aria-modal={drawerOpen ? true : undefined}
        role="dialog"
        inert={!drawerOpen}
      >
        <div className="drawer-top">
          <span>
            <span className="brand-dot" aria-hidden="true" />
            {brand.line1} · all sections
          </span>
          <button type="button" onClick={closeDrawer} aria-label="Close">
            ✕
          </button>
        </div>
        <button type="button" className="drawer-k" onClick={openPalette}>
          <span className="ph">Go to…</span>
          <span className="kbd">⌘ K</span>
        </button>
        <nav className="drawer-list">
          {nav.map((item, i) => {
            const isActive = item.href === current;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                onClick={closeDrawer}
              >
                <span className="n">{navNumber(i)}</span>
                <span>{item.label}</span>
                <span className="h">{isActive ? 'here' : '↗'}</span>
              </Link>
            );
          })}
        </nav>
        <div className="drawer-foot">
          <ThemeToggle surface="drawer" />
          <div className="ws-slot">{workspaceSwitcher}</div>
          <div className="row-acts">
            <span>
              <b>{footer.primary}</b>
            </span>
            <form action={footer.signOutAction} method="post">
              <button type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </aside>

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        nav={nav}
        actions={enhancedActions}
        footerRight={paletteFooterRight}
      />
    </>
  );
}
