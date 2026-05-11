'use client';

/**
 * Relay theme system.
 *
 * Canonical state lives on `<html data-theme="light|dark|marquee">` and is
 * set pre-hydration by an inline script in the root layout to avoid a flash.
 * (It's applied at :root so custom-property overrides cascade to the html
 * element itself — otherwise overscroll reveals the default light paper.)
 * The stored user preference ("light"|"dark"|"marquee"|"system") lives in
 * localStorage under `relay:theme`; "system" resolves at runtime via
 * `prefers-color-scheme: dark`.
 */

export type Theme = 'light' | 'dark' | 'marquee' | 'system';
type Resolved = 'light' | 'dark' | 'marquee';

const STORAGE_KEY = 'relay:theme';
const THEME_ATTR = 'data-theme';
const BUTTON_SELECTOR = '[data-theme-opt]';

const listeners = new Set<(t: Theme) => void>();

let mediaQuery: MediaQueryList | null = null;
let mediaHandler: ((e: MediaQueryListEvent) => void) | null = null;

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark' || v === 'marquee' || v === 'system';
}

function resolve(t: Theme): Resolved {
  if (t !== 'system') return t;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyResolved(r: Resolved): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.setAttribute(THEME_ATTR, r);
}

function syncButtons(stored: Theme): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLButtonElement>(BUTTON_SELECTOR).forEach((btn) => {
    const opt = btn.getAttribute('data-theme-opt');
    btn.setAttribute('aria-pressed', opt === stored ? 'true' : 'false');
  });
}

function notify(t: Theme): void {
  listeners.forEach((cb) => cb(t));
}

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(t: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* storage disabled — still apply for this session */
  }
  applyResolved(resolve(t));
  syncButtons(t);
  notify(t);
}

export function initTheme(): void {
  if (typeof window === 'undefined') return;
  const stored = getTheme();
  applyResolved(resolve(stored));
  syncButtons(stored);

  if (!mediaQuery) mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (mediaHandler) mediaQuery.removeEventListener('change', mediaHandler);
  mediaHandler = () => {
    if (getTheme() === 'system') applyResolved(resolve('system'));
  };
  mediaQuery.addEventListener('change', mediaHandler);
}

export function subscribeTheme(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
